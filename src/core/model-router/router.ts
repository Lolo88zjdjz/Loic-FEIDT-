/**
 * TOKEN MASTER — routage des modèles appelés PAR L'APPLICATION via l'API.
 * (Il ne pilote pas le modèle de la session Claude Code de développement.)
 * Objectif : coût minimal par tâche CORRECTEMENT exécutée, pas tokens minimaux.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/client";

export type OptimizationMode = "ECO" | "BALANCED" | "MAX_PERFORMANCE";
export type Tier = "fast" | "balanced" | "advanced";
export type Effort = "low" | "medium" | "high" | "xhigh";
export type TaskProfile = { complexity: "low" | "medium" | "high"; risk: "low" | "high"; contextTokens?: number; needsWeb?: boolean };
export type CostClass = "local" | "free_quota" | "paid";

/** Exigences vérifiables d'une tâche. */
export type Requirements = { minQuality: number; needsTools: boolean; needsWeb: boolean; minContext: number };

export type Candidate = {
  id: string; provider: string; costClass: CostClass | string; qualityTier: number; supportsTools: boolean; supportsWebSearch: boolean;
  contextWindow: number | null; inputPerMtok: string | number | null; outputPerMtok: string | number | null;
  availability: string; enabled: boolean; observedLatencyMs?: number | null;
};

export type ModelChoice = {
  modelId: string; provider: string; costClass: CostClass; effort: Effort; estimatedCostUsd: number;
  /** Exigences non satisfaites (mode dégradé assumé plutôt qu'un appel payant implicite). */
  unmet: string[]; reason: string[]; fallbacks: Candidate[];
};

const TIER_BASE: Record<Tier, number> = { fast: 1, balanced: 2, advanced: 3 };
const clamp = (n: number) => Math.max(1, Math.min(5, n));

export function requirementsFor(agentTier: Tier, profile: TaskProfile, mode: OptimizationMode, needsTools = true): Requirements {
  let q = TIER_BASE[agentTier];
  if (profile.complexity === "high") q += 1;
  if (profile.complexity === "low") q -= 1;
  if (profile.risk === "high") q += 1;
  if (mode === "ECO") q -= 1;
  if (mode === "MAX_PERFORMANCE") q += 1;
  return { minQuality: clamp(q), needsTools, needsWeb: !!profile.needsWeb, minContext: Math.min(32_000, (profile.contextTokens ?? 0) + 3_000) };
}

export function estimateCost(c: Candidate, inTok: number, outTok: number) {
  if (c.costClass !== "paid") return 0;
  return (inTok / 1e6) * Number(c.inputPerMtok ?? 0) + (outTok / 1e6) * Number(c.outputPerMtok ?? 0);
}

/**
 * TOKEN MASTER : parmi les modèles AUTORISÉS par la politique, le moins
 * coûteux qui satisfait toutes les exigences. À coût égal (0 $) : local
 * d'abord (confidentialité, pas de quota) sauf préférence contraire, puis le
 * plus petit modèle suffisant (plus rapide). Si aucun modèle autorisé ne
 * satisfait tout, on prend le meilleur modèle autorisé et on DÉCLARE les
 * exigences non satisfaites — jamais de bascule implicite vers un modèle payant.
 */
export function selectModel(all: Candidate[], req: Requirements, opts: {
  policy: "free_only" | "allow_paid"; preferLocal?: boolean; override?: string | null; mode: OptimizationMode; estIn?: number; estOut?: number;
}): ModelChoice | { none: true; reason: string[] } {
  const estIn = opts.estIn ?? 2000, estOut = opts.estOut ?? 600;
  const reason: string[] = [`Politique : ${opts.policy === "free_only" ? "100 % gratuit (aucun modèle payant)" : "payant autorisé (si moins cher capable indisponible)"}.`,
    `Exigences : niveau ≥ ${req.minQuality}${req.needsTools ? ", outils" : ""}${req.needsWeb ? ", recherche web" : ""}, contexte ≥ ${req.minContext} tokens.`];
  const usable = all.filter((c) => c.enabled && c.availability !== "unavailable" && (c.costClass !== "paid" || opts.policy === "allow_paid"));
  const blockedPaid = all.filter((c) => c.costClass === "paid" && opts.policy !== "allow_paid" && c.enabled);
  if (!usable.length) return { none: true, reason: [...reason, "Aucun modèle autorisé n'est disponible (Ollama arrêté ? aucune clé gratuite ?)."] };
  const meets = (c: Candidate) => [
    c.qualityTier < req.minQuality ? `niveau ${c.qualityTier} < ${req.minQuality}` : null,
    req.needsTools && !c.supportsTools ? "pas d'outils" : null,
    req.needsWeb && !c.supportsWebSearch ? "pas de recherche web" : null,
    (c.contextWindow ?? 4096) < req.minContext ? `contexte ${c.contextWindow ?? 4096} < ${req.minContext}` : null,
  ].filter(Boolean) as string[];
  const rank = (c: Candidate) => ({ local: opts.preferLocal === false ? 1 : 0, free_quota: opts.preferLocal === false ? 0 : 1, paid: 2 } as Record<string, number>)[c.costClass] ?? 3;
  const byCost = (a: Candidate, b: Candidate) => estimateCost(a, estIn, estOut) - estimateCost(b, estIn, estOut) || rank(a) - rank(b) || a.qualityTier - b.qualityTier || (a.observedLatencyMs ?? 0) - (b.observedLatencyMs ?? 0);

  let pool: Candidate[]; let unmet: string[] = [];
  const override = opts.override ? usable.find((c) => c.id === opts.override) : undefined;
  if (opts.override && !override) reason.push(`Modèle imposé « ${opts.override} » non autorisé ou indisponible : ignoré.`);
  if (override) { pool = [override, ...usable.filter((c) => c !== override).sort(byCost)]; unmet = meets(override); reason.push(`Modèle imposé par la configuration de l'agent.`); }
  else {
    const ok = usable.filter((c) => meets(c).length === 0).sort(byCost);
    if (ok.length) { pool = [...ok, ...usable.filter((c) => !ok.includes(c)).sort(byCost)]; reason.push(`${ok.length} modèle(s) satisfont tout : choix du moins coûteux (${estimateCost(ok[0], estIn, estOut).toFixed(5)} $ estimés).`); }
    else {
      // Dégradé : d'abord ceux qui ont les outils si requis, puis la meilleure qualité, puis le coût.
      pool = [...usable].sort((a, b) => meets(a).length - meets(b).length || b.qualityTier - a.qualityTier || byCost(a, b));
      unmet = meets(pool[0]);
      reason.push(`Aucun modèle autorisé ne satisfait tout : meilleur compromis gratuit retenu (limites : ${unmet.join(", ")}).`);
      const paidWouldFit = blockedPaid.filter((c) => meets(c).length === 0);
      if (paidWouldFit.length) reason.push(`Un modèle payant (${paidWouldFit[0].id}) conviendrait, mais il est bloqué par la politique gratuite.`);
    }
  }
  const c = pool[0];
  let effort: Effort = c.qualityTier >= 5 ? "high" : c.qualityTier >= 4 ? "medium" : "low";
  if (opts.mode === "MAX_PERFORMANCE") effort = effort === "low" ? "medium" : "high";
  if (opts.mode === "ECO") effort = "low";
  reason.push(`Retenu : ${c.id} (${c.costClass === "local" ? "local, 0 $" : c.costClass === "free_quota" ? "quota gratuit, 0 $" : "payant"}, niveau ${c.qualityTier}).`);
  return { modelId: c.id, provider: c.provider, costClass: c.costClass as CostClass, effort, estimatedCostUsd: estimateCost(c, estIn, estOut), unmet, reason, fallbacks: pool.slice(1, 4) };
}

/** Escalade : prochain candidat autorisé de niveau supérieur, une seule fois, sur critère vérifiable. */
export function escalate(choice: ModelChoice, all: Candidate[], failedCheck: string): ModelChoice | null {
  const next = choice.fallbacks.find((c) => c.qualityTier > (all.find((x) => x.id === choice.modelId)?.qualityTier ?? 0));
  if (!next) return null;
  return { ...choice, modelId: next.id, provider: next.provider, costClass: next.costClass as CostClass, fallbacks: choice.fallbacks.filter((c) => c !== next), reason: [...choice.reason, `Escalade vers ${next.id} : ${failedCheck}.`] };
}

export async function modelCandidates(): Promise<Candidate[]> {
  return db.select().from(schema.modelDefinitions) as unknown as Promise<Candidate[]>;
}

/** Estimation grossière (≈ 4 caractères / token) pour le pré-contrôle de budget uniquement. */
export const roughTokens = (s: string) => Math.ceil(s.length / 4);

export type BudgetState = { dayUsd: number; monthUsd: number; limits: { missionUsd: number; dayUsd: number; monthUsd: number }; blocked: string | null };

export async function budgetState(ownerId: string): Promise<BudgetState> {
  const prefs = await db.select().from(schema.userPreferences).where(and(eq(schema.userPreferences.ownerId, ownerId), eq(schema.userPreferences.scope, "budget")));
  const get = (k: string, d: number) => Number((prefs.find((p) => p.key === k)?.value as number | undefined) ?? d);
  const limits = { missionUsd: get("budget.mission_usd", 0.5), dayUsd: get("budget.day_usd", 2), monthUsd: get("budget.month_usd", 20) };
  const startDay = new Date(); startDay.setUTCHours(0, 0, 0, 0);
  const startMonth = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), 1));
  const [d] = (await db.execute(sql`SELECT coalesce(sum(cost_usd),0)::float AS s FROM model_usage WHERE owner_id = ${ownerId} AND created_at >= ${startDay}`)).rows as { s: number }[];
  const [m] = (await db.execute(sql`SELECT coalesce(sum(cost_usd),0)::float AS s FROM model_usage WHERE owner_id = ${ownerId} AND created_at >= ${startMonth}`)).rows as { s: number }[];
  const blocked = m.s >= limits.monthUsd ? `Plafond mensuel atteint (${m.s.toFixed(4)} $ / ${limits.monthUsd} $)` : d.s >= limits.dayUsd ? `Plafond journalier atteint (${d.s.toFixed(4)} $ / ${limits.dayUsd} $)` : null;
  return { dayUsd: d.s, monthUsd: m.s, limits, blocked };
}

export async function getMode(ownerId: string): Promise<OptimizationMode> {
  const [p] = await db.select().from(schema.userPreferences).where(and(eq(schema.userPreferences.ownerId, ownerId), eq(schema.userPreferences.key, "ai.optimization_mode")));
  return ((p?.value as OptimizationMode) ?? "BALANCED");
}

export async function unavailableModels() {
  const rows = await db.select({ id: schema.modelDefinitions.id }).from(schema.modelDefinitions).where(eq(schema.modelDefinitions.availability, "unavailable"));
  return rows.map((r) => r.id);
}

export async function usageSince(ownerId: string, since: Date) {
  return db.select().from(schema.modelUsage).where(and(eq(schema.modelUsage.ownerId, ownerId), gte(schema.modelUsage.createdAt, since)));
}
