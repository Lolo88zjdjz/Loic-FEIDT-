/**
 * Intégration RÉELLE avec un modèle local gratuit (Ollama).
 * Exécuté seulement si OLLAMA_DISABLED=0 et Ollama joignable :
 *   OLLAMA_DISABLED=0 pnpm vitest run tests/integration/ollama.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema, pool } from "@/core/db/client";
import { makeUser } from "../helpers";
import { handleMessage } from "@/core/orchestration/atlas";
import { createMemory } from "@/core/memory/service";

const enabled = process.env.OLLAMA_DISABLED === "0";
let U: { id: string };
beforeAll(async () => { if (enabled) U = await makeUser(); });
afterAll(async () => { await pool.end(); });

describe.skipIf(!enabled)("LLM local gratuit (Ollama)", () => {
  it("découvre les modèles locaux, gratuits et disponibles", async () => {
    const local = await db.select().from(schema.modelDefinitions).where(eq(schema.modelDefinitions.costClass, "local"));
    expect(local.length).toBeGreaterThan(0);
    expect(local.every((m) => Number(m.inputPerMtok) === 0)).toBe(true);
  });
  it("demande ouverte : réponse générée localement, 0 $, limites déclarées, aucun appel payant", async () => {
    const r = await handleMessage(U.id, "Écris en deux phrases pourquoi la montagne me fait du bien.");
    expect(r.mode).toBe("llm");
    expect(r.reply).toMatch(/localement par .*gratuit/);
    const usage = await db.select().from(schema.modelUsage).where(eq(schema.modelUsage.ownerId, U.id));
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => Number(u.costUsd) === 0 && u.costStatus === "free_local")).toBe(true);
    expect(usage.some((u) => u.modelId.startsWith("claude"))).toBe(false);
  }, 240_000);
  it("un agent utilise un outil réel (mémoire) via SENTINEL", async () => {
    await createMemory(U.id, { content: "Loïc vise un stage en business development dans l'outdoor à Paris au printemps 2027.", type: "project", category: "career" });
    const r = await handleMessage(U.id, "Utilise la recherche mémoire puis dis-moi quel type de stage je vise.", { agentId: "nexus" });
    expect(r.mode).toBe("llm");
    const tools = await db.select().from(schema.toolInvocations).where(eq(schema.toolInvocations.agentId, "nexus"));
    expect(tools.some((t) => t.toolName === "memory_search" && t.status === "ok")).toBe(true);
    expect(r.reply.toLowerCase()).toMatch(/business|outdoor|stage/);
  }, 240_000);
  it("politique « payant autorisé » sans clé LOÏC OS : toujours aucun appel payant", async () => {
    await db.insert(schema.userPreferences).values({ ownerId: U.id, key: "ai.cost_policy", scope: "ai", value: "allow_paid" });
    const r = await handleMessage(U.id, "Résume en une phrase ce qu'est Altigliss.");
    const runs = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.ownerId, U.id), eq(schema.agentRuns.id, r.runId)));
    expect(runs[0]).toBeTruthy();
    const usage = await db.select().from(schema.modelUsage).where(eq(schema.modelUsage.ownerId, U.id));
    expect(usage.some((u) => u.costStatus === "computed" || Number(u.costUsd) > 0)).toBe(false);
    // Utilisateur de test sans souvenir sur Altigliss : si le modèle répond quand même, la réponse doit être étiquetée non sourcée.
    if (!/n'ai pas|aucune information|ne sais pas/i.test(r.reply)) expect(r.reply).toMatch(/non sourcée/);
  }, 240_000);
});
