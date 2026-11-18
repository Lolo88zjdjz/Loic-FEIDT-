/**
 * Exécution d'un agent par un modèle de langage, QUEL QUE SOIT le fournisseur
 * (Ollama local, quota gratuit, Anthropic facultatif). La boucle d'outils est
 * gérée ici pour que chaque appel passe par SENTINEL et soit journalisé.
 *
 * Garanties :
 *  - le modèle est choisi par TOKEN MASTER parmi les modèles autorisés par la
 *    politique de coût (par défaut : 100 % gratuit) ;
 *  - tout appel passe par `callModel`, qui bloque un modèle payant non autorisé ;
 *  - un échec ne déclenche un repli que vers un autre modèle AUTORISÉ ;
 *  - les limites (modèle local, pas de web…) sont déclarées dans la réponse.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { SECURITY_RULES } from "../agents/definitions";
import { TOOL_MAP } from "../agents/tools";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../security/injection";
import { computeCost } from "../model-router/pricing";
import { budgetState, getMode, modelCandidates, requirementsFor, selectModel, type Candidate, type ModelChoice, type TaskProfile, type Tier } from "../model-router/router";
import { selectContextForAgent } from "../memory/service";
import { callModel, getCostPolicy, providerById } from "../llm/registry";
import { ProviderError, type ChatMessage, type ToolSpec } from "../llm/types";
import { QUALITY_LABEL } from "../llm/quality";
import { addStep, executeTool, finishRun, getAgent, LIMITS, startRun, type AgentRecord } from "./engine";
import type { Sensitivity } from "../shared";

const MAX_TOOL_RESULT_CHARS = 6000;
const compress = (v: unknown, max = MAX_TOOL_RESULT_CHARS) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + `… [tronqué : ${s.length} caractères]` : s; };

const SMALL_MODEL_RULES = "Tu es un petit modèle exécuté localement. Réponds en français, brièvement. Si tu n'es pas certain d'un fait, dis-le clairement au lieu de deviner. Utilise les outils pour toute donnée personnelle (mémoire, CRM, tâches) au lieu de l'inventer. Ne décris jamais une personne, une entreprise ou une association que tu ne trouves ni dans le contexte ni via un outil.";

/** Y a-t-il au moins un modèle autorisé et disponible ? (pas d'appel réseau) */
export async function llmAvailable(ownerId: string) {
  const policy = await getCostPolicy(ownerId);
  const all = await modelCandidates();
  return all.some((c) => c.enabled && c.availability !== "unavailable" && (c.costClass !== "paid" || policy === "allow_paid") && providerById(c.provider)?.isConfigured());
}

function toolSpecs(agent: AgentRecord, choice: ModelChoice, small: boolean): ToolSpec[] {
  const out: ToolSpec[] = [];
  for (const name of [...agent.tools].sort()) {
    if (name === "web_search") continue; // outil serveur Anthropic, passé via `webSearch`
    const t = TOOL_MAP.get(name); if (!t) continue;
    out.push({ name: t.name, description: small ? t.description.split(".")[0] : `[Niveau ${t.level}] ${t.description}`, parameters: z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown> });
  }
  // Délégation : réservée aux modèles assez capables (un petit modèle local s'y perd).
  if (agent.id === "atlas" && !small) out.push({ name: "delegate", description: "Délègue une sous-tâche précise à un agent spécialisé (nexus, dealmaker, scholar, athena, vital, nutri, nomad, capital, flow, wordsmith, oracle, plugin_architect, token_master). Maximum 3 délégations.",
    parameters: { type: "object", properties: { agent: { type: "string" }, objective: { type: "string" } }, required: ["agent", "objective"], additionalProperties: false } });
  void choice;
  return out;
}

export type LlmResult = { reply: string; sources: { kind: string; label: string; ref?: string }[]; status: "completed" | "waiting_approval" | "failed"; error?: string; model?: string; limitations?: string[] };

export async function runAgentLLM(opts: {
  ownerId: string; agentId: string; objective: string; profile: TaskProfile; conversationId?: string | null;
  history?: { role: "user" | "assistant"; content: string }[]; parentRunId?: string | null; rootRunId?: string | null; depth?: number; runId?: string;
}): Promise<LlmResult & { runId: string }> {
  const agent = await getAgent(opts.agentId);
  const [mode, policy, all] = await Promise.all([getMode(opts.ownerId), getCostPolicy(opts.ownerId), modelCandidates()]);
  const configured = all.filter((c) => providerById(c.provider)?.isConfigured());
  const req = requirementsFor(agent.modelTier as Tier, opts.profile, mode, true);
  const picked = selectModel(configured, req, { policy, mode, override: agent.modelOverride, preferLocal: true });

  const run = opts.runId
    ? (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, opts.runId)))[0]
    : await startRun({ ownerId: opts.ownerId, agentId: agent.id, objective: opts.objective, mode: "llm", parentRunId: opts.parentRunId, rootRunId: opts.rootRunId, depth: opts.depth, conversationId: opts.conversationId });
  if ("none" in picked) {
    await addStep(run.id, { kind: "model_select", agentId: "token_master", summary: "Aucun modèle autorisé disponible", data: { reason: picked.reason } });
    await finishRun(run.id, "failed", null, { error: "no_model" });
    return { runId: run.id, reply: "", sources: [], status: "failed", error: "no_model" };
  }
  let choice = picked;
  await db.update(schema.agentRuns).set({ mode: "llm", modelId: choice.modelId, modelReason: choice.reason.join(" ") }).where(eq(schema.agentRuns.id, run.id));
  await addStep(run.id, { kind: "model_select", agentId: "token_master", summary: `${choice.modelId} (${choice.costClass}${choice.unmet.length ? ", dégradé" : ""})`, data: { reason: choice.reason, unmet: choice.unmet, mode, policy } });

  if (choice.costClass === "paid") {
    const budget = await budgetState(opts.ownerId);
    if (budget.blocked) { await finishRun(run.id, "failed", null, { error: budget.blocked }); return { runId: run.id, reply: `⛔ ${budget.blocked}.`, sources: [], status: "failed", error: budget.blocked }; }
  }

  const context = await selectContextForAgent(opts.ownerId, { memoryScopes: agent.memoryScopes, maxSensitivity: agent.maxSensitivity as Sensitivity }, opts.objective, 8);
  await addStep(run.id, { kind: "context", agentId: agent.id, summary: `${context.length} souvenir(s) sélectionné(s)`, data: { memoryIds: context.map((m) => m.id) } });
  const contextBlock = context.length
    ? `Contexte issu de la mémoire de Loïc (avec dates d'observation) :\n${context.map((m) => `- [${m.category}|observé ${m.observedAt}|${m.confidenceStatus}] ${m.content}`).join("\n")}`
    : "Aucun souvenir pertinent trouvé en mémoire. Si la question porte sur Loïc, ses projets, ses contacts ou ses organisations, réponds que tu n'as pas cette information dans sa mémoire : n'invente rien.";

  const modelRow = () => all.find((c) => c.id === choice.modelId) as (Candidate & typeof schema.modelDefinitions.$inferSelect) | undefined;
  const isSmall = () => (modelRow()?.qualityTier ?? 3) <= 2;
  const system = () => `${SECURITY_RULES}\n\n${UNTRUSTED_DATA_RULE}\n\n${agent.systemPrompt}${isSmall() ? `\n\n${SMALL_MODEL_RULES}` : ""}`;
  const messages: ChatMessage[] = [
    ...(opts.history ?? []).slice(isSmall() ? -2 : -6).map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }) as ChatMessage),
    { role: "user", content: `${contextBlock}\n\nDate du jour : ${new Date().toISOString().slice(0, 10)}\n\nDemande : ${opts.objective}` },
  ];
  const sources: LlmResult["sources"] = context.map((m) => ({ kind: "memory", label: m.content.slice(0, 80), ref: m.id }));
  let delegations = 0, waiting = false, finalText = "", runCost = 0, triedFallback = false, groundedByTools = 0;
  const started = Date.now();

  try {
    for (let step = 0; step < agent.maxSteps; step++) {
      if (Date.now() - started > LIMITS.maxRunMs * (choice.costClass === "local" ? 3 : 1)) throw new Error("Durée maximale de l'exécution dépassée");
      const row = modelRow();
      const tools = row?.supportsTools ? toolSpecs(agent, choice, isSmall()) : [];
      let r;
      try {
        r = await callModel(opts.ownerId, { id: choice.modelId, provider: choice.provider, costClass: choice.costClass }, {
          system: system(), messages, tools, maxTokens: choice.costClass === "local" ? 700 : choice.costClass === "paid" ? 16000 : 2000,
          effort: choice.costClass === "paid" ? choice.effort : undefined, webSearch: req.needsWeb && !!row?.supportsWebSearch,
        });
      } catch (e) {
        // Repli UNIQUEMENT vers un autre modèle autorisé par la politique (jamais payant implicite).
        const next = choice.fallbacks.find((c) => c.costClass !== "paid" || policy === "allow_paid");
        if (e instanceof ProviderError && e.retryable && next && !triedFallback) {
          triedFallback = true;
          await addStep(run.id, { kind: "error", agentId: agent.id, summary: `${choice.modelId} : ${e.message} → repli sur ${next.id}` });
          choice = { ...choice, modelId: next.id, provider: next.provider, costClass: next.costClass as ModelChoice["costClass"], fallbacks: choice.fallbacks.filter((c) => c !== next) };
          step--; continue;
        }
        throw e;
      }
      const usage = r.usage;
      const priced = row ? computeCost(usage, row) : { costUsd: 0, status: "partial" as const };
      const cost = choice.costClass === "paid" ? priced : { costUsd: 0, status: choice.costClass === "local" ? "free_local" : "free_quota" };
      runCost += cost.costUsd;
      await db.insert(schema.modelUsage).values({ ownerId: opts.ownerId, runId: run.id, agentId: agent.id, modelId: r.servedModel, workflow: run.workflow, ...usage,
        costUsd: String(cost.costUsd), costStatus: cost.status, latencyMs: r.latencyMs, success: r.stopReason !== "refusal", attempt: step + 1, stopReason: r.stopReason });
      const tps = usage.outputTokens && r.latencyMs ? ` · ${(usage.outputTokens / (r.latencyMs / 1000)).toFixed(1)} tok/s` : "";
      await addStep(run.id, { kind: "llm_call", agentId: agent.id, summary: `${r.servedModel} · ${usage.inputTokens}+${usage.outputTokens} tokens · ${(r.latencyMs / 1000).toFixed(1)} s${tps} · ${cost.costUsd.toFixed(5)} $`, data: { stopReason: r.stopReason, toolCalls: r.toolCalls.map((t) => t.name) } });
      for (const w of r.webSources ?? []) sources.push({ kind: "web", label: `${w.title} (${w.date ?? "date inconnue"})`, ref: w.url });

      if (r.stopReason === "refusal") { finalText = "La demande a été refusée par le modèle (politique de sécurité)."; break; }
      if (runCost > Number(agent.maxCostUsd)) { finalText = `Budget de l'agent atteint (${runCost.toFixed(4)} $) : exécution arrêtée.`; break; }
      if (r.stopReason === "pause") { messages.push({ role: "assistant", content: r.text, raw: r.rawAssistant }); continue; }
      if (r.stopReason !== "tool_use") { finalText = r.text; break; }

      messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls, raw: r.rawAssistant });
      for (const tc of r.toolCalls) {
        if (tc.name === "delegate") {
          const inp = (tc.input ?? {}) as { agent?: string; objective?: string };
          if (delegations >= LIMITS.maxDelegationsPerRun || (run.depth ?? 0) >= LIMITS.maxDepth || !inp.agent || inp.agent === "atlas") {
            messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: "Délégation refusée (limite atteinte ou agent invalide).", isError: true }); continue;
          }
          delegations++;
          await addStep(run.id, { kind: "delegate", agentId: agent.id, targetAgentId: inp.agent, summary: `→ ${inp.agent} : ${inp.objective?.slice(0, 140)}` });
          const sub = await runAgentLLM({ ownerId: opts.ownerId, agentId: inp.agent, objective: inp.objective ?? "", profile: opts.profile, parentRunId: run.id, rootRunId: run.rootRunId ?? run.id, depth: (run.depth ?? 0) + 1, conversationId: opts.conversationId })
            .catch((e) => ({ reply: `Échec de ${inp.agent} : ${(e as Error).message}`, sources: [], status: "failed" as const, runId: "" }));
          sources.push(...sub.sources); if (sub.status === "waiting_approval") waiting = true;
          await addStep(run.id, { kind: "delegate", agentId: inp.agent, targetAgentId: agent.id, summary: `← ${inp.agent} (${sub.status})` });
          messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: wrapUntrusted("agent_output", inp.agent, sub.reply.slice(0, MAX_TOOL_RESULT_CHARS)) });
          continue;
        }
        await addStep(run.id, { kind: "tool_call", agentId: agent.id, summary: tc.name, data: { input: tc.input } });
        const out = await executeTool({ ownerId: opts.ownerId, runId: run.id, agent }, tc.name, tc.input);
        if (out.status === "waiting_approval") waiting = true;
        if (out.status === "ok") groundedByTools++;
        if (out.status === "ok" && tc.name === "docs_search") for (const c of out.output as { title: string; documentId: string; page: number | null }[]) sources.push({ kind: "document", label: `${c.title}${c.page ? ` p.${c.page}` : ""}`, ref: c.documentId });
        messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, isError: out.status === "error" || out.status === "denied",
          content: out.status === "ok" ? wrapUntrusted("tool_output", tc.name, compress(out.output, isSmall() ? 2500 : MAX_TOOL_RESULT_CHARS))
            : out.status === "waiting_approval" ? `En attente d'approbation utilisateur (id ${out.approvalId}). Ne considère pas l'action comme effectuée.`
            : out.status === "denied" ? `Refusé par SENTINEL : ${out.reason}` : `Erreur : ${out.error}` });
      }
      if (step === agent.maxSteps - 1) finalText = r.text || "Nombre maximal d'étapes atteint.";
    }
    const row = modelRow();
    const limitations = [
      choice.costClass === "local" ? `Réponse générée localement par ${choice.modelId} (gratuit, niveau ${row?.qualityTier ?? "?"} — ${QUALITY_LABEL[row?.qualityTier ?? 0] ?? ""}) : vérifiez les faits importants.` : null,
      choice.costClass === "free_quota" ? `Réponse d'un modèle à quota gratuit (${choice.modelId}) : quota limité, conditions de données à vérifier.` : null,
      ...choice.unmet.map((u) => (u === "pas de recherche web" ? "Aucune recherche web effectuée (aucun modèle gratuit disponible n'en dispose) : informations non actualisées." : `Exigence non satisfaite : ${u}.`)),
    ].filter(Boolean) as string[];
    // SENTINEL : une réponse qui ne s'appuie sur AUCUNE donnée (ni souvenir, ni résultat d'outil, ni source web) est signalée.
    const ungrounded = context.length === 0 && groundedByTools === 0 && !sources.some((x) => x.kind === "web");
    if (ungrounded) {
      limitations.unshift("⚠️ Réponse non sourcée : aucune donnée de votre cerveau n'a été trouvée ni consultée. À considérer comme une supposition du modèle, pas comme un fait.");
      await addStep(run.id, { kind: "validation", agentId: "sentinel", summary: "Réponse non sourcée (aucun souvenir, aucun outil) : étiquetée comme supposition" });
    }
    const reply = (finalText.trim() || "(réponse vide du modèle)") + (limitations.length ? `\n\n_${limitations.join(" ")}_` : "");
    await addStep(run.id, { kind: "final", agentId: agent.id, summary: "Réponse finale" });
    await finishRun(run.id, waiting ? "waiting_approval" : "completed", { reply }, { sources });
    return { runId: run.id, reply, sources, status: waiting ? "waiting_approval" : "completed", model: choice.modelId, limitations };
  } catch (e) {
    const err = (e as Error).message;
    await addStep(run.id, { kind: "error", agentId: agent.id, summary: err });
    await finishRun(run.id, "failed", null, { error: err });
    return { runId: run.id, reply: `⚠️ ${err}`, sources, status: "failed", error: err };
  }
}
