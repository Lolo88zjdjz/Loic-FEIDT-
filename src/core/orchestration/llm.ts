/**
 * Exécution LLM d'un agent (API Anthropic, boucle d'outils manuelle afin que
 * CHAQUE appel passe par SENTINEL et soit journalisé). Actif uniquement si
 * ANTHROPIC_API_KEY est défini pour l'application.
 *
 * Optimisations : préfixe système stable mis en cache (cache_control), outils
 * dans un ordre déterministe, contexte mémoire ciblé, sorties d'outils
 * compressées, plafonds d'étapes/coût/délégation, repli serveur en cas de refus.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { SECURITY_RULES } from "../agents/definitions";
import { TOOL_MAP } from "../agents/tools";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../security/injection";
import { computeCost } from "../model-router/pricing";
import { chooseModel, escalate, getMode, unavailableModels, budgetState, type TaskProfile, type Tier } from "../model-router/router";
import { selectContextForAgent } from "../memory/service";
import { addStep, executeTool, finishRun, getAgent, LIMITS, startRun, type AgentRecord } from "./engine";
import type { Sensitivity } from "../shared";

export const llmAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client: Anthropic | null = null;
function anthropic() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  return client;
}

const MAX_TOOL_RESULT_CHARS = 6000;
const compress = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > MAX_TOOL_RESULT_CHARS ? s.slice(0, MAX_TOOL_RESULT_CHARS) + `… [tronqué : ${s.length} caractères]` : s;
};

function toolDefinitions(agent: AgentRecord, modelCaps: string[]): Anthropic.Beta.BetaToolUnion[] {
  const defs: Anthropic.Beta.BetaToolUnion[] = [];
  for (const name of [...agent.tools].sort()) {
    if (name === "web_search") {
      if (modelCaps.includes("web_search_20260209")) defs.push({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
      continue;
    }
    const t = TOOL_MAP.get(name);
    if (!t) continue;
    defs.push({ name: t.name, description: `[Niveau ${t.level}] ${t.description}`, input_schema: z.toJSONSchema(t.input, { io: "input" }) as Anthropic.Beta.BetaTool.InputSchema });
  }
  if (agent.id === "atlas") {
    defs.push({ name: "delegate", description: "Délègue une sous-tâche précise à un agent spécialisé (nexus, dealmaker, scholar, athena, vital, nutri, nomad, capital, flow, wordsmith, oracle, plugin_architect, token_master). Maximum 3 délégations.",
      input_schema: { type: "object", properties: { agent: { type: "string" }, objective: { type: "string" } }, required: ["agent", "objective"], additionalProperties: false } });
  }
  return defs;
}

export type LlmResult = { reply: string; sources: { kind: string; label: string; ref?: string }[]; status: "completed" | "waiting_approval" | "failed"; error?: string };

export async function runAgentLLM(opts: {
  ownerId: string; agentId: string; objective: string; profile: TaskProfile; conversationId?: string | null;
  history?: { role: "user" | "assistant"; content: string }[]; parentRunId?: string | null; rootRunId?: string | null; depth?: number; runId?: string;
}): Promise<LlmResult & { runId: string }> {
  const agent = await getAgent(opts.agentId);
  const mode = await getMode(opts.ownerId);
  const unavailable = await unavailableModels();
  let choice = chooseModel({ agentTier: agent.modelTier as Tier, profile: opts.profile, mode, override: agent.modelOverride, unavailable });

  const run = opts.runId
    ? (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, opts.runId)))[0]
    : await startRun({ ownerId: opts.ownerId, agentId: agent.id, objective: opts.objective, mode: "llm", parentRunId: opts.parentRunId, rootRunId: opts.rootRunId, depth: opts.depth, conversationId: opts.conversationId, modelId: choice.modelId, modelReason: choice.reason.join(" ") });
  await db.update(schema.agentRuns).set({ mode: "llm", modelId: choice.modelId, modelReason: choice.reason.join(" ") }).where(eq(schema.agentRuns.id, run.id));
  await addStep(run.id, { kind: "model_select", agentId: "token_master", summary: `${choice.modelId} (effort ${choice.effort})`, data: { reason: choice.reason, mode } });

  const budget = await budgetState(opts.ownerId);
  if (budget.blocked) {
    await finishRun(run.id, "failed", null, { error: budget.blocked });
    return { runId: run.id, reply: `⛔ ${budget.blocked}. Ajustez les plafonds dans Paramètres → Budgets.`, sources: [], status: "failed", error: budget.blocked };
  }

  // Contexte ciblé : seulement les souvenirs autorisés pour cet agent.
  const context = await selectContextForAgent(opts.ownerId, { memoryScopes: agent.memoryScopes, maxSensitivity: agent.maxSensitivity as Sensitivity }, opts.objective, 8);
  await addStep(run.id, { kind: "context", agentId: agent.id, summary: `${context.length} souvenir(s) sélectionné(s)`, data: { memoryIds: context.map((m) => m.id) } });
  const contextBlock = context.length
    ? `Contexte issu de la mémoire de Loïc (avec dates d'observation) :\n${context.map((m) => `- [${m.id.slice(0, 8)}|${m.category}|observé ${m.observedAt}|${m.confidenceStatus}] ${m.content}`).join("\n")}`
    : "Aucun souvenir pertinent trouvé en mémoire.";

  const [modelRow] = await db.select().from(schema.modelDefinitions).where(eq(schema.modelDefinitions.id, choice.modelId));
  const caps = (modelRow?.capabilities as string[]) ?? [];
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: `${SECURITY_RULES}\n\n${UNTRUSTED_DATA_RULE}\n\n${agent.systemPrompt}`, cache_control: { type: "ephemeral" } }];
  const tools = toolDefinitions(agent, caps);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...(opts.history ?? []).slice(-6).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: `${contextBlock}\n\nDate du jour : ${new Date().toISOString().slice(0, 10)}\n\nDemande : ${opts.objective}` },
  ];

  const sources: LlmResult["sources"] = context.map((m) => ({ kind: "memory", label: m.content.slice(0, 80), ref: m.id }));
  let delegations = 0; let waiting = false; let finalText = ""; let runCost = 0;
  const started = Date.now();
  const fallbackEnabled = process.env.LOIC_OS_REFUSAL_FALLBACK !== "0" && ["claude-opus-5-5", "claude-sonnet-5-5"].includes(choice.modelId);

  try {
    for (let step = 0; step < agent.maxSteps; step++) {
      if (Date.now() - started > LIMITS.maxRunMs) throw new Error("Durée maximale de l'exécution dépassée");
      const t0 = Date.now();
      const response = await anthropic().beta.messages.create({
        model: choice.modelId, max_tokens: 16000, system, tools, messages,
        output_config: { effort: choice.effort },
        ...(fallbackEnabled ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      const u = response.usage;
      const usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 };
      const servedModel = response.model;
      const [priceRow] = servedModel === choice.modelId ? [modelRow] : await db.select().from(schema.modelDefinitions).where(eq(schema.modelDefinitions.id, servedModel));
      const cost = priceRow ? computeCost(usage, priceRow) : { costUsd: 0, status: "partial" as const };
      runCost += cost.costUsd;
      await db.insert(schema.modelUsage).values({ ownerId: opts.ownerId, runId: run.id, agentId: agent.id, modelId: servedModel, workflow: run.workflow, ...usage,
        costUsd: String(cost.costUsd), costStatus: cost.status, latencyMs: Date.now() - t0, success: response.stop_reason !== "refusal", attempt: step + 1, stopReason: response.stop_reason });
      await addStep(run.id, { kind: "llm_call", agentId: agent.id, summary: `${servedModel} · ${usage.inputTokens}+${usage.outputTokens} tokens (cache lu ${usage.cacheReadTokens}) · ${cost.costUsd.toFixed(5)} $`, data: { stopReason: response.stop_reason } });

      if (response.stop_reason === "refusal") { finalText = "La demande a été refusée par le modèle (politique de sécurité)."; break; }
      if (runCost > Number(agent.maxCostUsd)) { finalText = `Budget de l'agent atteint (${runCost.toFixed(4)} $ / ${agent.maxCostUsd} $) : exécution arrêtée.`; break; }

      const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
      for (const b of response.content) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) sources.push({ kind: "web", label: `${r.title} (${r.page_age ?? "date inconnue"})`, ref: r.url });
      }
      if (response.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: response.content }); continue; }
      if (response.stop_reason !== "tool_use") {
        // Escalade unique si la réponse est tronquée (critère vérifiable).
        if (response.stop_reason === "max_tokens") { const up = escalate(choice, "réponse tronquée (max_tokens)"); if (up && step === 0) { choice = up; continue; } }
        finalText = text; break;
      }
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const b of response.content) {
        if (b.type !== "tool_use") continue;
        if (b.name === "delegate") {
          const inp = b.input as { agent?: string; objective?: string };
          if (delegations >= LIMITS.maxDelegationsPerRun || (run.depth ?? 0) >= LIMITS.maxDepth || !inp.agent || inp.agent === "atlas") {
            results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "Délégation refusée (limite atteinte ou agent invalide)." }); continue;
          }
          delegations++;
          await addStep(run.id, { kind: "delegate", agentId: agent.id, targetAgentId: inp.agent, summary: `→ ${inp.agent} : ${inp.objective?.slice(0, 140)}` });
          const sub = await runAgentLLM({ ownerId: opts.ownerId, agentId: inp.agent, objective: inp.objective ?? "", profile: opts.profile, parentRunId: run.id, rootRunId: run.rootRunId ?? run.id, depth: (run.depth ?? 0) + 1, conversationId: opts.conversationId }).catch((e) => ({ reply: `Échec de ${inp.agent} : ${(e as Error).message}`, sources: [], status: "failed" as const, runId: "" }));
          sources.push(...sub.sources);
          if (sub.status === "waiting_approval") waiting = true;
          await addStep(run.id, { kind: "delegate", agentId: inp.agent, targetAgentId: agent.id, summary: `← ${inp.agent} (${sub.status})` });
          results.push({ type: "tool_result", tool_use_id: b.id, content: wrapUntrusted("agent_output", inp.agent, sub.reply.slice(0, MAX_TOOL_RESULT_CHARS)) });
          continue;
        }
        await addStep(run.id, { kind: "tool_call", agentId: agent.id, summary: `${b.name}`, data: { input: b.input } });
        const out = await executeTool({ ownerId: opts.ownerId, runId: run.id, agent }, b.name, b.input);
        if (out.status === "waiting_approval") waiting = true;
        const content = out.status === "ok" ? wrapUntrusted("tool_output", b.name, compress(out.output))
          : out.status === "waiting_approval" ? `En attente d'approbation utilisateur (id ${out.approvalId}). Ne considère pas l'action comme effectuée.`
          : out.status === "denied" ? `Refusé par SENTINEL : ${out.reason}` : `Erreur : ${out.error}`;
        if (out.status === "ok" && b.name === "docs_search") for (const c of out.output as { title: string; documentId: string; page: number | null }[]) sources.push({ kind: "document", label: `${c.title}${c.page ? ` p.${c.page}` : ""}`, ref: c.documentId });
        results.push({ type: "tool_result", tool_use_id: b.id, content, is_error: out.status !== "ok" && out.status !== "waiting_approval" });
      }
      messages.push({ role: "user", content: results });
      if (step === agent.maxSteps - 1) finalText = text || "Nombre maximal d'étapes atteint.";
    }
    const status = waiting ? "waiting_approval" : "completed";
    await addStep(run.id, { kind: "final", agentId: agent.id, summary: "Réponse finale" });
    await finishRun(run.id, status, { reply: finalText }, { sources });
    return { runId: run.id, reply: finalText, sources, status };
  } catch (e) {
    const err = e instanceof Anthropic.AuthenticationError ? "Clé API invalide (401)." : e instanceof Anthropic.RateLimitError ? "Limite de débit atteinte (429), réessayez plus tard." : e instanceof Anthropic.APIError ? `Erreur API ${e.status} : ${e.message}` : (e as Error).message;
    await addStep(run.id, { kind: "error", agentId: agent.id, summary: err });
    await finishRun(run.id, "failed", null, { error: err });
    return { runId: run.id, reply: `⚠️ ${err}`, sources, status: "failed", error: err };
  }
}

/** Vérifie la disponibilité réelle des modèles via GET /v1/models (nécessite la clé). */
export async function verifyModelAvailability() {
  if (!llmAvailable()) return { checked: false as const, reason: "ANTHROPIC_API_KEY absent" };
  const ids = new Set<string>();
  for await (const m of anthropic().models.list()) ids.add(m.id);
  const rows = await db.select().from(schema.modelDefinitions);
  for (const r of rows) await db.update(schema.modelDefinitions).set({ availability: ids.has(r.id) ? "available" : "unavailable", availabilityCheckedAt: new Date() }).where(eq(schema.modelDefinitions.id, r.id));
  return { checked: true as const, available: [...ids] };
}
