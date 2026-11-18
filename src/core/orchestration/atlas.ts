/**
 * ATLAS — point d'entrée de toute demande (Command Center, API, automatisations).
 * 1. Routage (déterministe d'abord : explicable et gratuit)
 * 2. Workflow minimal : réponse déterministe si l'intention est reconnue,
 *    sinon LLM (si clé API), sinon recherche « Ask My Brain » sans IA.
 * 3. SENTINEL valide (permissions déjà appliquées outil par outil), ATLAS
 *    synthétise et enregistre la conversation.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { route } from "./intent";
import { runDeterministic, type DetResult } from "./deterministic";
import { llmAvailable, runAgentLLM } from "./llm";
import { addStep, finishRun, getAgent, startRun } from "./engine";
import { searchMemories } from "../memory/service";
import { searchDocuments } from "../knowledge/service";
import { searchNodes } from "../graph/service";

export type AtlasReply = {
  conversationId: string; runId: string; agentId: string; mode: "deterministic" | "llm" | "brain_search";
  reply: string; sources: DetResult["sources"]; status: string; routing: { matched: string[]; confidence: string; intent: string }; data?: unknown;
};

export async function handleMessage(ownerId: string, text: string, opts: { conversationId?: string | null; agentId?: string | null } = {}): Promise<AtlasReply> {
  const clean = text.trim().slice(0, 8000);
  let conversationId = opts.conversationId ?? null;
  if (!conversationId) {
    const [c] = await db.insert(schema.conversations).values({ ownerId, title: clean.slice(0, 80) }).returning();
    conversationId = c.id;
  }
  const history = (await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(asc(schema.messages.createdAt))).slice(-6)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  await db.insert(schema.messages).values({ conversationId, role: "user", content: clean });

  const r = route(clean, opts.agentId);
  const target = await getAgent(r.agentId);
  if (!target.enabled) r.agentId = "atlas";

  const root = await startRun({ ownerId, agentId: "atlas", objective: clean, mode: "deterministic", conversationId, input: { text: clean }, workflow: "chat" });
  await addStep(root.id, { kind: "route", agentId: "atlas", targetAgentId: r.agentId, summary: `Intention « ${r.intent.kind} » → ${r.agentId.toUpperCase()} (${r.confidence}${r.matched.length ? ` : ${r.matched.join(", ")}` : ""})`, data: { profile: r.profile } });

  let runId = root.id;
  if (r.agentId !== "atlas") {
    const child = await startRun({ ownerId, agentId: r.agentId, objective: clean, mode: "deterministic", parentRunId: root.id, rootRunId: root.id, depth: 1, conversationId, workflow: "chat" });
    await addStep(root.id, { kind: "delegate", agentId: "atlas", targetAgentId: r.agentId, summary: `→ ${r.agentId.toUpperCase()}` });
    runId = child.id;
  }

  let result: DetResult & { mode: AtlasReply["mode"] };
  const det = await runDeterministic(ownerId, runId, r.agentId, r.intent);
  if (!det.needsLlm) {
    await addStep(runId, { kind: "model_select", agentId: "token_master", summary: "Aucun modèle IA nécessaire : traitement déterministe (0 $)" });
    result = { ...det, mode: "deterministic" };
  } else {
    const llm = (await llmAvailable(ownerId)) ? await runAgentLLM({ ownerId, agentId: r.agentId, objective: clean, profile: r.profile, conversationId, history, runId, rootRunId: root.id, depth: runId === root.id ? 0 : 1 }) : null;
    if (llm && llm.error !== "no_model") result = { reply: llm.reply, sources: llm.sources, status: llm.status, mode: "llm" };
    else {
      await addStep(runId, { kind: "model_select", agentId: "token_master", summary: "Aucun modèle autorisé disponible (Ollama arrêté, aucune clé gratuite) : recherche dans le cerveau" });
      result = { ...(await brainSearch(ownerId, runId, clean)), mode: "brain_search" };
    }
  }

  // SENTINEL : bilan de contrôle de l'exécution
  const [ctrl] = (await db.execute(sql`SELECT count(*) FILTER (WHERE status='denied')::int AS denied, count(*) FILTER (WHERE status='waiting_approval')::int AS waiting, count(*)::int AS total
    FROM tool_invocations WHERE run_id IN (SELECT id FROM agent_runs WHERE root_run_id = ${root.id} OR id = ${root.id})`)).rows as { denied: number; waiting: number; total: number }[];
  await addStep(root.id, { kind: "validation", agentId: "sentinel", summary: `${ctrl.total} appel(s) d'outil contrôlé(s), ${ctrl.denied} bloqué(s), ${ctrl.waiting} en attente d'approbation`, data: ctrl });

  const status = result.status === "failed" ? "failed" : result.status === "waiting_approval" ? "waiting_approval" : "completed";
  if (runId !== root.id && result.mode !== "llm") await finishRun(runId, status, { reply: result.reply }, { sources: result.sources });
  await addStep(root.id, { kind: "final", agentId: "atlas", summary: `Synthèse (${result.mode})` });
  if (!(result.mode === "llm" && runId === root.id)) await finishRun(root.id, status, { reply: result.reply, delegatedTo: r.agentId }, { sources: result.sources });
  else await db.update(schema.agentRuns).set({ status }).where(eq(schema.agentRuns.id, root.id));

  await db.insert(schema.messages).values({ conversationId, role: "assistant", content: result.reply, runId: root.id });
  await db.update(schema.conversations).set({ updatedAt: new Date() }).where(eq(schema.conversations.id, conversationId));
  return { conversationId, runId: root.id, agentId: r.agentId, mode: result.mode, reply: result.reply, sources: result.sources, status, data: result.data,
    routing: { matched: r.matched, confidence: r.confidence, intent: r.intent.kind } };
}

/** Ask My Brain sans IA : mémoire + documents + graphe, résultats bruts sourcés. */
export async function brainSearch(ownerId: string, runId: string, query: string): Promise<DetResult> {
  const [mem, docs, nodes] = await Promise.all([
    searchMemories(ownerId, query, { limit: 6, maxSensitivity: "private" }),
    searchDocuments(ownerId, query, { limit: 4 }),
    searchNodes(ownerId, query.split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(" ") || query, 6),
  ]);
  await addStep(runId, { kind: "context", agentId: "atlas", summary: `Recherche cerveau : ${mem.length} souvenir(s), ${docs.length} passage(s), ${nodes.length} nœud(s)` });
  const lines = [
    "_Mode dégradé : aucun modèle IA disponible. Voici ce que contient votre cerveau sur ce sujet (aucun texte généré) :_", "",
  ];
  if (mem.length) lines.push("**Mémoire**", ...mem.map((m) => `- ${m.content} _(${m.category}, observé ${m.observedAt}, ${m.confidenceStatus})_`), "");
  if (docs.length) lines.push("**Documents**", ...docs.map((d) => `- **${d.title}**${d.page ? ` p.${d.page}` : ""} — ${d.excerpt}`), "");
  if (nodes.length) lines.push("**Graphe**", ...nodes.map((n) => `- ${n.type} : ${n.label}`), "");
  if (!mem.length && !docs.length && !nodes.length) lines.push("Rien de pertinent dans la mémoire, les documents ou le graphe.");
  lines.push("Pour une réponse rédigée gratuite : lancez Ollama avec un modèle local (voir README → IA gratuite).");
  return { reply: lines.join("\n"), status: "completed",
    sources: [...mem.map((m) => ({ kind: "memory", label: m.content.slice(0, 60), ref: m.id })), ...docs.map((d) => ({ kind: "document", label: d.title, ref: d.documentId }))] };
}

export async function conversationMessages(ownerId: string, conversationId: string) {
  const [c] = await db.select().from(schema.conversations).where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.ownerId, ownerId)));
  if (!c) return null;
  return { conversation: c, messages: await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(asc(schema.messages.createdAt)) };
}
