/**
 * Moteur d'exécution des agents : cycle de vie des runs, étapes journalisées,
 * contrôle SENTINEL de chaque appel d'outil, approbations, garde-fous.
 * Indépendant de la session Claude Code de développement.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { AGENT_MAP } from "../agents/definitions";
import { TOOL_MAP } from "../agents/tools";
import { checkToolPermission } from "../security/permissions";
import { audit } from "../security/audit";
import { redactSecrets } from "../security/redact";
import { AppError, type Sensitivity } from "../shared";

export const LIMITS = { maxDepth: 2, maxDelegationsPerRun: 3, maxToolCallsPerRun: 12, maxRunMs: 120_000 };

export type AgentRecord = typeof schema.agentDefinitions.$inferSelect;

export async function getAgent(id: string): Promise<AgentRecord> {
  const [a] = await db.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.id, id));
  if (!a) throw new AppError(`Agent inconnu : ${id}`, "unknown_agent", 404);
  return a;
}

export async function startRun(r: {
  ownerId: string; agentId: string; objective: string; mode: "llm" | "deterministic"; input?: Record<string, unknown>;
  parentRunId?: string | null; rootRunId?: string | null; conversationId?: string | null; depth?: number; workflow?: string;
  modelId?: string | null; modelReason?: string | null;
}) {
  if ((r.depth ?? 0) > LIMITS.maxDepth) throw new AppError("Profondeur de délégation maximale atteinte", "max_depth");
  const [run] = await db.insert(schema.agentRuns).values({
    ownerId: r.ownerId, agentId: r.agentId, objective: r.objective, mode: r.mode, input: (redactSecrets(r.input ?? {}) as Record<string, unknown>),
    parentRunId: r.parentRunId ?? null, rootRunId: r.rootRunId ?? null, conversationId: r.conversationId ?? null,
    depth: r.depth ?? 0, workflow: r.workflow ?? "chat", status: "running", startedAt: new Date(), modelId: r.modelId ?? null, modelReason: r.modelReason ?? null,
  }).returning();
  if (!r.rootRunId) await db.update(schema.agentRuns).set({ rootRunId: run.id }).where(eq(schema.agentRuns.id, run.id));
  return { ...run, rootRunId: r.rootRunId ?? run.id };
}

export async function addStep(runId: string, s: { kind: string; agentId: string; summary: string; targetAgentId?: string; data?: Record<string, unknown> }) {
  const [{ n }] = (await db.execute(sql`SELECT coalesce(max(ordinal), 0)::int + 1 AS n FROM agent_run_steps WHERE run_id = ${runId}`)).rows as { n: number }[];
  const [step] = await db.insert(schema.agentRunSteps).values({ runId, ordinal: n, kind: s.kind, agentId: s.agentId, targetAgentId: s.targetAgentId,
    summary: s.summary, data: redactSecrets(s.data ?? {}) as Record<string, unknown> }).returning();
  return step;
}

export async function finishRun(runId: string, status: "completed" | "failed" | "waiting_approval" | "cancelled", output: unknown, extra: { error?: string; sources?: unknown[] } = {}) {
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  const cost = (await db.execute(sql`SELECT coalesce(sum(cost_usd),0)::float AS c FROM model_usage WHERE run_id = ${runId}`)).rows[0] as { c: number };
  await db.update(schema.agentRuns).set({
    status, output: redactSecrets(output) as object, error: extra.error, sources: extra.sources ?? run.sources,
    endedAt: new Date(), durationMs: run.startedAt ? Date.now() - run.startedAt.getTime() : null, costUsd: String(cost.c),
  }).where(eq(schema.agentRuns.id, runId));
}

async function autoApproveInternal(ownerId: string) {
  const [p] = await db.select().from(schema.userPreferences).where(and(eq(schema.userPreferences.ownerId, ownerId), eq(schema.userPreferences.key, "security.auto_approve_internal")));
  return p ? Boolean(p.value) : true;
}

export type ToolOutcome =
  | { status: "ok"; output: unknown; invocationId: string }
  | { status: "denied"; reason: string; invocationId: string }
  | { status: "waiting_approval"; approvalId: string; reason: string; invocationId: string }
  | { status: "error"; error: string; invocationId: string };

/**
 * SENTINEL : point de passage unique pour tout appel d'outil, déterministe
 * ou issu d'un LLM. Valide l'entrée (Zod), applique les permissions,
 * crée les demandes d'approbation, journalise l'invocation.
 */
export async function executeTool(ctx: { ownerId: string; runId: string; agent: AgentRecord }, toolName: string, rawInput: unknown): Promise<ToolOutcome> {
  const t0 = Date.now();
  const tool = TOOL_MAP.get(toolName);
  const record = async (status: string, output: unknown, extra: { approvalId?: string } = {}) => {
    const [inv] = await db.insert(schema.toolInvocations).values({
      runId: ctx.runId, agentId: ctx.agent.id, toolName, input: (redactSecrets(rawInput ?? {}) as object), output: redactSecrets(output) as object,
      status, permissionLevel: tool?.level ?? 0, approvalId: extra.approvalId, durationMs: Date.now() - t0,
    }).returning();
    return inv.id;
  };
  if (!tool) return { status: "denied", reason: `Outil inconnu : ${toolName}`, invocationId: await record("denied", { reason: "unknown_tool" }) };

  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM tool_invocations WHERE run_id = ${ctx.runId}`)).rows as { n: number }[];
  if (n >= LIMITS.maxToolCallsPerRun) return { status: "denied", reason: "Nombre maximal d'appels d'outils atteint pour cette exécution", invocationId: await record("denied", { reason: "max_tool_calls" }) };

  const decision = checkToolPermission({
    agentId: ctx.agent.id, agentTools: ctx.agent.tools, agentLevel: ctx.agent.permissionLevel, toolName, toolLevel: tool.level,
    destructive: tool.destructive, financial: tool.financial, autoApproveInternal: await autoApproveInternal(ctx.ownerId),
  });
  if (!decision.allowed) {
    await audit(db, { ownerId: ctx.ownerId, actor: "agent:sentinel", action: "tool.denied", entityType: "tool", entityId: toolName, details: { agent: ctx.agent.id, reason: decision.reason } });
    await addStep(ctx.runId, { kind: "validation", agentId: "sentinel", summary: `Bloqué : ${decision.reason}` });
    return { status: "denied", reason: decision.reason, invocationId: await record("denied", { reason: decision.reason }) };
  }
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const err = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { status: "error", error: `Entrée invalide : ${err}`, invocationId: await record("error", { error: err }) };
  }
  if (decision.requiresApproval) {
    const [a] = await db.insert(schema.approvalRequests).values({
      ownerId: ctx.ownerId, runId: ctx.runId, agentId: ctx.agent.id, toolName, permissionLevel: tool.level,
      actionSummary: tool.preview?.(parsed.data) ?? `${toolName}`, preview: JSON.stringify(parsed.data, null, 2), payload: parsed.data as object,
      idempotencyKey: `${ctx.runId}:${toolName}:${JSON.stringify(parsed.data)}`.slice(0, 500), expiresAt: new Date(Date.now() + 7 * 86400_000),
    }).onConflictDoNothing().returning();
    const approvalId = a?.id ?? "";
    await addStep(ctx.runId, { kind: "approval", agentId: "sentinel", summary: `Approbation requise : ${tool.preview?.(parsed.data) ?? toolName}`, data: { approvalId, reason: decision.reason } });
    return { status: "waiting_approval", approvalId, reason: decision.reason, invocationId: await record("waiting_approval", { approvalId }, { approvalId }) };
  }
  try {
    const output = await tool.run({ ownerId: ctx.ownerId, agentId: ctx.agent.id, runId: ctx.runId, maxSensitivity: ctx.agent.maxSensitivity as Sensitivity, memoryScopes: ctx.agent.memoryScopes }, parsed.data);
    return { status: "ok", output, invocationId: await record("ok", output) };
  } catch (e) {
    const msg = (e as Error).message;
    return { status: "error", error: msg, invocationId: await record("error", { error: msg }) };
  }
}

/** Exécution d'une action approuvée. Idempotente : une approbation ne s'exécute qu'une fois. */
export async function decideApproval(ownerId: string, approvalId: string, decision: "approve" | "reject") {
  const [a] = await db.update(schema.approvalRequests).set({ status: decision === "approve" ? "approved" : "rejected", decidedAt: new Date() })
    .where(and(eq(schema.approvalRequests.id, approvalId), eq(schema.approvalRequests.ownerId, ownerId), eq(schema.approvalRequests.status, "pending"))).returning();
  if (!a) throw new AppError("Demande introuvable ou déjà traitée", "not_pending", 409);
  await audit(db, { ownerId, actor: "user", action: decision === "approve" ? "approval.approved" : "approval.rejected", entityType: "approval", entityId: a.id, details: { tool: a.toolName, summary: a.actionSummary } });
  if (decision === "reject") return { status: "rejected" as const };
  if (a.expiresAt && a.expiresAt < new Date()) {
    await db.update(schema.approvalRequests).set({ status: "expired" }).where(eq(schema.approvalRequests.id, a.id));
    return { status: "expired" as const };
  }
  const tool = TOOL_MAP.get(a.toolName);
  if (!tool) throw new AppError("Outil inconnu");
  const agent = await getAgent(a.agentId);
  try {
    const result = await tool.run({ ownerId, agentId: a.agentId, runId: a.runId ?? "", maxSensitivity: agent.maxSensitivity as Sensitivity, memoryScopes: agent.memoryScopes }, tool.input.parse(a.payload));
    const blocked = (result as { blocked?: string })?.blocked;
    await db.update(schema.approvalRequests).set({ status: blocked ? "failed" : "executed", result: result as object }).where(eq(schema.approvalRequests.id, a.id));
    if (a.runId) await addStep(a.runId, { kind: "approval", agentId: "sentinel", summary: blocked ? `Approuvé mais non exécuté : ${blocked}` : `Action approuvée et exécutée : ${a.actionSummary}` });
    return { status: blocked ? ("failed" as const) : ("executed" as const), result };
  } catch (e) {
    await db.update(schema.approvalRequests).set({ status: "failed", result: { error: (e as Error).message } }).where(eq(schema.approvalRequests.id, a.id));
    return { status: "failed" as const, result: { error: (e as Error).message } };
  }
}

export function agentStatic(id: string) { return AGENT_MAP.get(id); }
