/** Synchronise le registre des agents, des modèles et des automatisations en base (+ nœuds du graphe). Idempotent. */
import { sql } from "drizzle-orm";
import { db, schema } from "./db/client";
import { AGENTS } from "./agents/definitions";
import { MODEL_SEEDS, PRICING_SOURCE, PRICING_VERIFIED_AT } from "./model-router/registry";
import { AUTOMATION_SEEDS } from "./workflows/automations";
import { link, upsertEntityNode } from "./graph/service";
import { TOOLS } from "./agents/tools";

export async function syncRegistries(ownerId: string) {
  await db.transaction(async (tx) => {
    for (const m of MODEL_SEEDS) {
      const v = { provider: "anthropic", displayName: m.displayName, tier: m.tier, inputPerMtok: String(m.inputPerMtok), outputPerMtok: String(m.outputPerMtok),
        cacheReadPerMtok: m.cacheReadPerMtok === null ? null : String(m.cacheReadPerMtok), cacheWritePerMtok: m.cacheWritePerMtok === null ? null : String(m.cacheWritePerMtok),
        contextWindow: m.contextWindow, maxOutput: m.maxOutput, capabilities: m.capabilities, limits: m.limits, pricingSource: PRICING_SOURCE, pricingVerifiedAt: PRICING_VERIFIED_AT, updatedAt: new Date() };
      await tx.insert(schema.modelDefinitions).values({ id: m.id, ...v }).onConflictDoUpdate({ target: schema.modelDefinitions.id, set: v });
      await upsertEntityNode(tx, { ownerId, type: "Model", label: m.displayName, refTable: "model_definitions", refId: m.id, properties: { tier: m.tier }, sensitivity: "public" });
    }
    for (const a of AGENTS) {
      // Les champs réglables par l'utilisateur (modèle, budget, activation) ne sont pas écrasés.
      await tx.insert(schema.agentDefinitions).values({ id: a.id, name: a.name, title: a.title, mission: a.mission, description: a.description, systemPrompt: a.systemPrompt,
        promptVersion: a.promptVersion, tools: a.tools, memoryScopes: a.memoryScopes, maxSensitivity: a.maxSensitivity, modelTier: a.modelTier, maxCostUsd: String(a.maxCostUsd),
        maxSteps: a.maxSteps, permissionLevel: a.permissionLevel, implementation: a.implementation })
        .onConflictDoUpdate({ target: schema.agentDefinitions.id, set: { name: a.name, title: a.title, mission: a.mission, description: a.description, systemPrompt: a.systemPrompt,
          promptVersion: a.promptVersion, tools: a.tools, memoryScopes: a.memoryScopes, maxSensitivity: a.maxSensitivity, permissionLevel: a.permissionLevel, implementation: a.implementation, updatedAt: new Date() } });
      const node = await upsertEntityNode(tx, { ownerId, type: "Agent", label: a.name, refTable: "agent_definitions", refId: a.id, description: a.mission, properties: { title: a.title, implementation: a.implementation }, sensitivity: "public" });
      for (const t of a.tools) {
        const tn = await upsertEntityNode(tx, { ownerId, type: "Tool", label: t, refTable: "tools", refId: t, description: TOOLS.find((x) => x.name === t)?.description ?? "Outil serveur Anthropic (web search)", sensitivity: "public" });
        await link(tx, { ownerId, type: "USED_BY", source: tn.id, target: node.id, provenance: "Registre des agents : outil autorisé", sensitivity: "public" });
      }
    }
    for (const s of AUTOMATION_SEEDS) {
      await tx.insert(schema.automations).values({ ownerId, key: s.key, name: s.name, description: s.description, cron: s.cron, requiresLlm: s.requiresLlm, config: s.key === "partnership_followup" ? { days: 10 } : {} })
        .onConflictDoUpdate({ target: [schema.automations.ownerId, schema.automations.key], set: { name: s.name, description: s.description, requiresLlm: s.requiresLlm } });
    }
    await tx.execute(sql`SELECT 1`);
  });
}
