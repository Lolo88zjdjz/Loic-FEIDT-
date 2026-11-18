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

const TIERS: Tier[] = ["fast", "balanced", "advanced"];
const TIER_MODEL: Record<Tier, string> = { fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", advanced: "claude-opus-5-5" };
const TIER_EFFORT: Record<Tier, Effort> = { fast: "low", balanced: "medium", advanced: "high" };

export type ModelChoice = { modelId: string; tier: Tier; effort: Effort; reason: string[] };

export function chooseModel(opts: {
  agentTier: Tier; profile: TaskProfile; mode: OptimizationMode; override?: string | null;
  unavailable?: string[];
}): ModelChoice {
  const reason: string[] = [];
  if (opts.override) {
    return { modelId: opts.override, tier: opts.agentTier, effort: TIER_EFFORT[opts.agentTier], reason: [`Modèle imposé par la configuration de l'agent (${opts.override}).`] };
  }
  let idx = TIERS.indexOf(opts.agentTier);
  reason.push(`Niveau par défaut de l'agent : ${opts.agentTier}.`);
  if (opts.profile.risk === "high" || opts.profile.complexity === "high") {
    if (idx < 2) { idx = 2; reason.push(`Tâche ${opts.profile.risk === "high" ? "à risque élevé" : "complexe"} : modèle avancé directement (pas d'escalade progressive).`); }
  } else if (opts.profile.complexity === "low" && idx > 0) {
    idx -= 1; reason.push("Tâche simple : un niveau en dessous suffit.");
  }
  if (opts.profile.needsWeb && idx === 0) { idx = 1; reason.push("Recherche web requise : outil web_search_20260209 non listé pour Haiku dans le registre → Sonnet."); }
  if (opts.mode === "ECO" && opts.profile.risk !== "high" && idx > 0 && !(opts.profile.needsWeb && idx === 1)) { idx -= 1; reason.push("Mode ECO : descente d'un niveau (risque faible)."); }
  if (opts.mode === "MAX_PERFORMANCE" && idx < 2) { idx += 1; reason.push("Mode MAX PERFORMANCE : montée d'un niveau."); }
  if ((opts.profile.contextTokens ?? 0) > 100_000 && TIERS[idx] === "fast") reason.push("Attention : au-delà de 100K tokens, le tarif Haiku 5.5 passe à 0,50 $/2,50 $.");
  // Disponibilité : si un modèle est marqué indisponible, on prend le niveau supérieur, sinon inférieur.
  let tier = TIERS[idx];
  if (opts.unavailable?.includes(TIER_MODEL[tier])) {
    const alt = TIERS.find((t, i) => i > idx && !opts.unavailable!.includes(TIER_MODEL[t])) ?? [...TIERS].reverse().find((t) => !opts.unavailable!.includes(TIER_MODEL[t]));
    if (alt) { reason.push(`${TIER_MODEL[tier]} indisponible : bascule vers ${TIER_MODEL[alt]}.`); tier = alt; }
  }
  let effort = TIER_EFFORT[tier];
  if (opts.mode === "ECO" && effort !== "low") effort = effort === "high" ? "medium" : "low";
  if (opts.mode === "MAX_PERFORMANCE") effort = effort === "low" ? "medium" : effort === "medium" ? "high" : "xhigh";
  reason.push(`Effort : ${effort}.`);
  return { modelId: TIER_MODEL[tier], tier, effort, reason };
}

/** Escalade contrôlée : uniquement si des critères VÉRIFIABLES échouent, une seule fois. */
export function escalate(choice: ModelChoice, failedCheck: string): ModelChoice | null {
  const idx = TIERS.indexOf(choice.tier);
  if (idx >= 2) return null;
  const tier = TIERS[idx + 1];
  return { modelId: TIER_MODEL[tier], tier, effort: TIER_EFFORT[tier], reason: [...choice.reason, `Escalade vers ${TIER_MODEL[tier]} : ${failedCheck}.`] };
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
