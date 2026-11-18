/**
 * Mémoire persistante LOÏC OS.
 * - Toute écriture crée une révision (memory_revisions) et synchronise le graphe.
 * - Les remplacements conservent l'ancienne version (status = superseded).
 * - La recherche est hybride : plein texte français (ts_rank) + trigrammes +
 *   fraîcheur + statut. Le vecteur (pgvector) est utilisé seulement lorsqu'un
 *   fournisseur d'embeddings est configuré (voir MEMORY_DESIGN.md).
 * - La confiance est un STATUT justifiable (user_confirmed, imported_historical…),
 *   jamais une probabilité arbitraire.
 */
import { and, desc, eq, inArray, lt, sql, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "../db/client";
import { emit } from "../graph/sync";
import { canAccess, type Sensitivity, todayISO, AppError } from "../shared";

export type Memory = typeof schema.memories.$inferSelect;

export const memoryInput = z.object({
  content: z.string().trim().min(3).max(4000),
  type: z.enum(["identity", "episodic", "semantic", "procedural", "project", "temporary"]),
  category: z.string().trim().min(2).max(60),
  sensitivity: z.enum(["public", "personal", "private", "sensitive"]).default("personal"),
  confidenceStatus: z.enum(["user_confirmed", "imported_historical", "document_extracted", "agent_inferred", "unverified"]).default("user_confirmed"),
  observedAt: z.string().date().nullable().optional(),
  validFrom: z.string().date().nullable().optional(),
  validUntil: z.string().date().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  sourceId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
});
export type MemoryInput = z.input<typeof memoryInput>;

async function nextRevision(tx: Tx, memoryId: string) {
  const r = await tx.execute(sql`SELECT coalesce(max(revision), 0)::int + 1 AS n FROM memory_revisions WHERE memory_id = ${memoryId}`);
  return (r.rows[0] as { n: number }).n;
}

async function snapshot(tx: Tx, m: Memory, changeType: string, actor: string, reason?: string) {
  const { search: _s, embedding: _e, ...rest } = m;
  await tx.insert(schema.memoryRevisions).values({ memoryId: m.id, revision: await nextRevision(tx, m.id), changeType, snapshot: rest, changedBy: actor, reason });
}

export async function createMemory(ownerId: string, input: MemoryInput, actor = "user", tx: Tx = db): Promise<Memory> {
  const v = memoryInput.parse(input);
  const run = async (t: Tx) => {
    // Déduplication stricte : même contenu actif dans la même catégorie ⇒ on renvoie l'existant.
    const [dup] = await t.select().from(schema.memories).where(and(eq(schema.memories.ownerId, ownerId),
      eq(schema.memories.status, "active"), eq(schema.memories.category, v.category), eq(schema.memories.content, v.content)));
    if (dup) return dup;
    const [m] = await t.insert(schema.memories).values({ ...v, ownerId, observedAt: v.observedAt ?? todayISO() }).returning();
    await snapshot(t, m, "create", actor);
    await emit(t, ownerId, actor, { type: "memory.upserted", id: m.id });
    return m;
  };
  return tx === db ? db.transaction(run) : run(tx);
}

export async function getMemory(ownerId: string, id: string) {
  const [m] = await db.select().from(schema.memories).where(and(eq(schema.memories.ownerId, ownerId), eq(schema.memories.id, id)));
  if (!m) throw new AppError("Souvenir introuvable", "not_found", 404);
  return m;
}

/** Modification en place (correction d'une faute, reclassement). */
export async function updateMemory(ownerId: string, id: string, patch: Partial<MemoryInput>, actor = "user", reason?: string) {
  const v = memoryInput.partial().parse(patch);
  return db.transaction(async (tx) => {
    const [m] = await tx.update(schema.memories).set({ ...v, updatedAt: new Date() })
      .where(and(eq(schema.memories.ownerId, ownerId), eq(schema.memories.id, id))).returning();
    if (!m) throw new AppError("Souvenir introuvable", "not_found", 404);
    await snapshot(tx, m, "update", actor, reason);
    await emit(tx, ownerId, actor, { type: "memory.upserted", id });
    return m;
  });
}

/** Une information plus récente remplace l'ancienne ; l'ancienne est conservée (superseded). */
export async function supersedeMemory(ownerId: string, oldId: string, input: Partial<MemoryInput> & { content: string }, actor = "user", reason?: string) {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(schema.memories).where(and(eq(schema.memories.ownerId, ownerId), eq(schema.memories.id, oldId)));
    if (!old) throw new AppError("Souvenir introuvable", "not_found", 404);
    const v = memoryInput.parse({ type: old.type, category: old.category, sensitivity: old.sensitivity, projectId: old.projectId, ...input });
    const [oldUpdated] = await tx.update(schema.memories).set({ status: "superseded", validUntil: old.validUntil ?? todayISO(), updatedAt: new Date() })
      .where(eq(schema.memories.id, oldId)).returning();
    await snapshot(tx, oldUpdated, "supersede", actor, reason);
    const [m] = await tx.insert(schema.memories).values({ ...v, ownerId, supersedesId: oldId, observedAt: v.observedAt ?? todayISO() }).returning();
    await snapshot(tx, m, "create", actor, reason ?? "Remplace une version antérieure");
    await emit(tx, ownerId, actor, { type: "memory.upserted", id: oldId }); // nœud archivé, conservé pour l'historique
    await emit(tx, ownerId, actor, { type: "memory.upserted", id: m.id });
    return m;
  });
}

/** Suppression logique (récupérable) ; `purge` efface définitivement contenu et révisions. */
export async function deleteMemory(ownerId: string, id: string, actor = "user", purge = false) {
  return db.transaction(async (tx) => {
    const [m] = await tx.select().from(schema.memories).where(and(eq(schema.memories.ownerId, ownerId), eq(schema.memories.id, id)));
    if (!m) throw new AppError("Souvenir introuvable", "not_found", 404);
    await emit(tx, ownerId, actor, { type: "memory.removed", id });
    if (purge) {
      await tx.delete(schema.memories).where(eq(schema.memories.id, id));
      await tx.delete(schema.graphNodes).where(and(eq(schema.graphNodes.refTable, "memories"), eq(schema.graphNodes.refId, id)));
      return { purged: true };
    }
    const [u] = await tx.update(schema.memories).set({ status: "deleted", updatedAt: new Date() }).where(eq(schema.memories.id, id)).returning();
    await snapshot(tx, u, "delete", actor);
    return { purged: false };
  });
}

export async function restoreMemory(ownerId: string, id: string, actor = "user") {
  return db.transaction(async (tx) => {
    const [u] = await tx.update(schema.memories).set({ status: "active", updatedAt: new Date() })
      .where(and(eq(schema.memories.ownerId, ownerId), eq(schema.memories.id, id))).returning();
    if (!u) throw new AppError("Souvenir introuvable", "not_found", 404);
    await snapshot(tx, u, "restore", actor);
    await emit(tx, ownerId, actor, { type: "memory.upserted", id });
    return u;
  });
}

/** Expire les souvenirs dont valid_until est dépassé (appelé par le worker). */
export async function expireMemories(ownerId: string) {
  return db.transaction(async (tx) => {
    const rows = await tx.update(schema.memories).set({ status: "expired", updatedAt: new Date() }).where(and(
      eq(schema.memories.ownerId, ownerId), eq(schema.memories.status, "active"),
      isNotNull(schema.memories.validUntil), lt(schema.memories.validUntil, todayISO()))).returning();
    for (const m of rows) { await snapshot(tx, m, "expire", "worker"); await emit(tx, ownerId, "worker", { type: "memory.removed", id: m.id }); }
    return rows.length;
  });
}

export async function revisions(memoryId: string) {
  return db.select().from(schema.memoryRevisions).where(eq(schema.memoryRevisions.memoryId, memoryId)).orderBy(desc(schema.memoryRevisions.revision));
}

// ── Recherche ─────────────────────────────────────────────────────
export type MemoryHit = Memory & { score: number; matchedBy: string[] };

export async function searchMemories(ownerId: string, query: string, opts: {
  limit?: number; categories?: string[]; maxSensitivity?: Sensitivity; includeInactive?: boolean;
} = {}): Promise<MemoryHit[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = opts.limit ?? 10;
  const rows = await db.execute(sql`
    WITH params AS (SELECT websearch_to_tsquery('french', ${q}) AS tq, ${q}::text AS raw)
    SELECT m.id,
      ts_rank_cd(m.search, p.tq) AS fts,
      word_similarity(p.raw, m.content) AS trg,
      (m.search @@ p.tq) AS fts_hit
    FROM memories m, params p
    WHERE m.owner_id = ${ownerId}
      ${opts.includeInactive ? sql`` : sql`AND m.status = 'active'`}
      ${opts.categories?.length ? sql`AND m.category IN (${sql.join(opts.categories.map((c) => sql`${c}`), sql`, `)})` : sql``}
      AND ((m.search @@ p.tq) OR word_similarity(p.raw, m.content) > 0.35 OR m.content ILIKE ${"%" + q + "%"})
    ORDER BY (ts_rank_cd(m.search, p.tq) * 2 + word_similarity(p.raw, m.content)) DESC
    LIMIT ${limit * 3}`);
  const scored = rows.rows as { id: string; fts: number; trg: number; fts_hit: boolean }[];
  if (!scored.length) return [];
  const full = await db.select().from(schema.memories).where(inArray(schema.memories.id, scored.map((r) => r.id)));
  const byId = new Map(full.map((m) => [m.id, m]));
  const maxS = opts.maxSensitivity ?? "private";
  return scored
    .map((r) => {
      const m = byId.get(r.id)!;
      const ageDays = m.observedAt ? (Date.now() - new Date(m.observedAt).getTime()) / 86400_000 : 365;
      const recency = Math.max(0, 1 - ageDays / 730) * 0.15; // bonus de fraîcheur, ≤ 0.15
      const confidence = m.confidenceStatus === "user_confirmed" ? 0.1 : 0;
      const matchedBy = [r.fts_hit ? "plein texte" : null, r.trg > 0.35 ? "similarité" : null].filter(Boolean) as string[];
      return { ...m, score: Number(r.fts) * 2 + Number(r.trg) + recency + confidence, matchedBy: matchedBy.length ? matchedBy : ["sous-chaîne"] };
    })
    .filter((m) => canAccess(maxS, m.sensitivity))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function listMemories(ownerId: string, f: { status?: string; category?: string; type?: string } = {}) {
  return db.select().from(schema.memories).where(and(
    eq(schema.memories.ownerId, ownerId),
    f.status ? eq(schema.memories.status, f.status as Memory["status"]) : inArray(schema.memories.status, ["active", "contested"]),
    f.category ? eq(schema.memories.category, f.category) : undefined,
    f.type ? eq(schema.memories.type, f.type as Memory["type"]) : undefined,
  )).orderBy(desc(schema.memories.observedAt), desc(schema.memories.createdAt));
}

/**
 * Détection de contradictions candidates : souvenirs actifs de la même
 * catégorie, très proches lexicalement mais différents. Résultat à valider
 * par l'utilisateur (jamais de résolution automatique).
 */
export async function findContradictionCandidates(ownerId: string) {
  const r = await db.execute(sql`
    SELECT a.id AS a_id, a.content AS a_content, a.observed_at AS a_obs, b.id AS b_id, b.content AS b_content, b.observed_at AS b_obs,
           a.category, similarity(a.content, b.content) AS sim
    FROM memories a JOIN memories b ON a.category = b.category AND a.id < b.id AND a.owner_id = b.owner_id
    WHERE a.owner_id = ${ownerId} AND a.status = 'active' AND b.status = 'active'
      AND similarity(a.content, b.content) BETWEEN 0.45 AND 0.97
    ORDER BY sim DESC LIMIT 20`);
  return r.rows as { a_id: string; a_content: string; a_obs: string; b_id: string; b_content: string; b_obs: string; category: string; sim: number }[];
}

/**
 * Sélection de contexte pour un agent : uniquement les catégories autorisées
 * et une sensibilité ≤ plafond de l'agent. Les données « sensitive » (santé…)
 * ne sortent que si l'agent y est explicitement habilité.
 */
export async function selectContextForAgent(ownerId: string, agent: { memoryScopes: string[]; maxSensitivity: Sensitivity }, query: string, limit = 8) {
  const scopes = agent.memoryScopes.includes("*") ? undefined : agent.memoryScopes;
  const hits = await searchMemories(ownerId, query, { limit, categories: scopes, maxSensitivity: agent.maxSensitivity });
  // Complète avec les préférences procédurales (communication) si autorisées.
  const procedural = scopes && !scopes.includes("communication") ? [] : await db.select().from(schema.memories).where(and(
    eq(schema.memories.ownerId, ownerId), eq(schema.memories.status, "active"), eq(schema.memories.type, "procedural"),
    eq(schema.memories.category, "communication"))).limit(6);
  const seen = new Set(hits.map((h) => h.id));
  return [...hits, ...procedural.filter((p) => !seen.has(p.id) && canAccess(agent.maxSensitivity, p.sensitivity))];
}

export const MEMORY_CATEGORIES = [
  "identity", "communication", "education", "career", "partnerships", "sport", "health", "nutrition", "travel", "interests", "finance", "system",
] as const;
