/**
 * Registre des fournisseurs + garde-fou « aucun appel payant implicite ».
 * TOUT appel de modèle passe par `callModel`, qui vérifie la politique de
 * coût AVANT d'appeler le fournisseur.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { ChatRequest, ChatResponse, CostClass, LlmProvider } from "./types";
import { ProviderError } from "./types";
import { OllamaProvider } from "./providers/ollama";
import { FREE_PRESETS, OpenAICompatibleProvider } from "./providers/openai-compatible";
import { AnthropicProvider } from "./providers/anthropic";
import { PRICING_SOURCE, PRICING_VERIFIED_AT } from "../model-router/registry";

export const PROVIDERS: LlmProvider[] = [new OllamaProvider(), ...FREE_PRESETS.map((p) => new OpenAICompatibleProvider(p)), new AnthropicProvider()];
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

export type CostPolicy = "free_only" | "allow_paid";
export const DEFAULT_COST_POLICY: CostPolicy = "free_only";

export async function getCostPolicy(ownerId: string): Promise<CostPolicy> {
  const [p] = await db.select().from(schema.userPreferences).where(and(eq(schema.userPreferences.ownerId, ownerId), eq(schema.userPreferences.key, "ai.cost_policy")));
  return p?.value === "allow_paid" ? "allow_paid" : DEFAULT_COST_POLICY;
}

/** Garde-fou central : un modèle payant n'est JAMAIS appelé si la politique est free_only. */
export function assertCallAllowed(costClass: CostClass, policy: CostPolicy) {
  if (costClass === "paid" && policy !== "allow_paid")
    throw new ProviderError("Appel payant bloqué : la politique de coût est « 100 % gratuit ». Activez explicitement les modèles payants dans Settings.", "policy", false, 402);
}

export async function callModel(ownerId: string, model: { id: string; provider: string; costClass: string }, req: Omit<ChatRequest, "model">): Promise<ChatResponse> {
  assertCallAllowed(model.costClass as CostClass, await getCostPolicy(ownerId));
  const p = providerById(model.provider);
  if (!p) throw new ProviderError(`Fournisseur inconnu : ${model.provider}`, model.provider);
  if (!p.isConfigured()) throw new ProviderError(`Fournisseur non configuré : ${p.label}`, p.id);
  if (p.costClass !== model.costClass) throw new ProviderError("Incohérence de classe de coût", p.id); // défense en profondeur
  return p.chat({ ...req, model: model.id });
}

/**
 * Découverte réelle des modèles de tous les fournisseurs configurés et mise à
 * jour du registre. Un modèle absent lors de la découverte devient « unavailable ».
 */
export async function syncModelRegistry() {
  const report: { provider: string; configured: boolean; models: number; error?: string }[] = [];
  const now = new Date();
  for (const p of PROVIDERS) {
    if (!p.isConfigured() && p.costClass !== "paid") { report.push({ provider: p.id, configured: false, models: 0 }); await markProvider(p.id, "unavailable"); continue; }
    try {
      const models = await p.discover();
      let availableIds: string[] | null = null;
      if (p instanceof AnthropicProvider && p.isConfigured()) availableIds = await p.listAvailableIds().catch(() => null);
      for (const m of models) {
        const availability = p.costClass === "paid" ? (availableIds ? (availableIds.includes(m.id) ? "available" : "unavailable") : "unverified") : "available";
        const v = { provider: m.provider, displayName: m.displayName, tier: m.qualityTier <= 2 ? "fast" : m.qualityTier === 3 ? "balanced" : "advanced", costClass: m.costClass,
          qualityTier: m.qualityTier, qualityBasis: m.qualityBasis, supportsTools: m.supportsTools, supportsWebSearch: m.supportsWebSearch, parameterSize: m.parameterSize,
          freeLimits: m.freeLimits, limits: m.limits, contextWindow: m.contextWindow, maxOutput: null,
          inputPerMtok: m.inputPerMtok === null ? null : String(m.inputPerMtok), outputPerMtok: m.outputPerMtok === null ? null : String(m.outputPerMtok),
          cacheReadPerMtok: m.cacheReadPerMtok === null ? null : String(m.cacheReadPerMtok), cacheWritePerMtok: m.cacheWritePerMtok === null ? null : String(m.cacheWritePerMtok),
          capabilities: [m.supportsTools ? "tool_use" : null, m.supportsWebSearch ? "web_search_20260209" : null].filter(Boolean),
          availability, availabilityCheckedAt: now, updatedAt: now,
          pricingSource: m.costClass === "paid" ? PRICING_SOURCE : m.costClass === "local" ? "Exécution locale : aucun coût API." : "Quota gratuit du fournisseur : 0 $ dans la limite du quota.",
          pricingVerifiedAt: m.costClass === "paid" ? PRICING_VERIFIED_AT : now.toISOString().slice(0, 10) };
        await db.insert(schema.modelDefinitions).values({ id: m.id, ...v }).onConflictDoUpdate({ target: schema.modelDefinitions.id, set: v });
      }
      const ids = new Set(models.map((m) => m.id));
      for (const r of await db.select().from(schema.modelDefinitions).where(eq(schema.modelDefinitions.provider, p.id)))
        if (!ids.has(r.id)) await db.update(schema.modelDefinitions).set({ availability: "unavailable", availabilityCheckedAt: now }).where(eq(schema.modelDefinitions.id, r.id));
      report.push({ provider: p.id, configured: p.isConfigured(), models: models.length });
    } catch (e) { report.push({ provider: p.id, configured: p.isConfigured(), models: 0, error: (e as Error).message }); }
  }
  return report;
}
async function markProvider(provider: string, availability: string) {
  await db.update(schema.modelDefinitions).set({ availability, availabilityCheckedAt: new Date() }).where(eq(schema.modelDefinitions.provider, provider));
}
