/**
 * Neural Core — graphe persistant (tables graph_nodes / graph_edges).
 * - upsertEntityNode : idempotent via l'index unique (owner, ref_table, ref_id)
 * - link : idempotent via l'index unique (source, target, type)
 * - toute modification est historisée dans graph_changes
 */
import { and, eq, inArray, or, sql, ne } from "drizzle-orm";
import { db, schema, type Tx } from "../db/client";
import type { EdgeType, NodeType, Sensitivity } from "../shared";
import { canAccess } from "../shared";

export type NodeRow = typeof schema.graphNodes.$inferSelect;
export type EdgeRow = typeof schema.graphEdges.$inferSelect;

export async function upsertEntityNode(tx: Tx, n: {
  ownerId: string; type: NodeType; label: string; refTable: string | null; refId: string | null;
  description?: string | null; properties?: Record<string, unknown>; sensitivity?: Sensitivity;
  sourceId?: string | null; actor?: string; status?: string;
}): Promise<NodeRow> {
  const values = {
    ownerId: n.ownerId, type: n.type, label: n.label, refTable: n.refTable, refId: n.refId,
    description: n.description ?? null, properties: n.properties ?? {}, sensitivity: n.sensitivity ?? "personal",
    sourceId: n.sourceId ?? null, status: n.status ?? "active",
  };
  if (n.refTable && n.refId) {
    const [existing] = await tx.select().from(schema.graphNodes).where(and(
      eq(schema.graphNodes.ownerId, n.ownerId), eq(schema.graphNodes.refTable, n.refTable), eq(schema.graphNodes.refId, n.refId)));
    if (existing) {
      const changed = existing.label !== values.label || existing.description !== values.description ||
        existing.status !== values.status || existing.sensitivity !== values.sensitivity ||
        JSON.stringify(existing.properties) !== JSON.stringify(values.properties);
      if (!changed) return existing;
      const [updated] = await tx.update(schema.graphNodes).set({ ...values, updatedAt: new Date() })
        .where(eq(schema.graphNodes.id, existing.id)).returning();
      await recordChange(tx, n.ownerId, "node", existing.id, "update", existing, updated, n.actor ?? "system");
      return updated;
    }
  }
  const [created] = await tx.insert(schema.graphNodes).values(values).returning();
  await recordChange(tx, n.ownerId, "node", created.id, "create", null, created, n.actor ?? "system");
  return created;
}

export async function findEntityNode(tx: Tx, ownerId: string, refTable: string, refId: string) {
  const [row] = await tx.select().from(schema.graphNodes).where(and(
    eq(schema.graphNodes.ownerId, ownerId), eq(schema.graphNodes.refTable, refTable), eq(schema.graphNodes.refId, refId)));
  return row ?? null;
}

export async function link(tx: Tx, e: {
  ownerId: string; type: EdgeType; source: string; target: string; provenance: string;
  validation?: "confirmed" | "inferred"; confidenceNote?: string; sourceId?: string | null;
  sensitivity?: Sensitivity; observedAt?: string | null; actor?: string;
}): Promise<EdgeRow> {
  if (e.source === e.target) throw new Error("Une relation ne peut pas relier un nœud à lui-même");
  const [existing] = await tx.select().from(schema.graphEdges).where(and(
    eq(schema.graphEdges.sourceNodeId, e.source), eq(schema.graphEdges.targetNodeId, e.target), eq(schema.graphEdges.type, e.type)));
  if (existing) {
    // Une relation confirmée n'est jamais rétrogradée en « inférée ».
    if (existing.status === "retired" || (existing.validation === "inferred" && e.validation === "confirmed")) {
      const [u] = await tx.update(schema.graphEdges).set({ status: "active", validation: e.validation ?? existing.validation, provenance: e.provenance })
        .where(eq(schema.graphEdges.id, existing.id)).returning();
      await recordChange(tx, e.ownerId, "edge", existing.id, "update", existing, u, e.actor ?? "system");
      return u;
    }
    return existing;
  }
  const [created] = await tx.insert(schema.graphEdges).values({
    ownerId: e.ownerId, type: e.type, sourceNodeId: e.source, targetNodeId: e.target, provenance: e.provenance,
    validation: e.validation ?? "confirmed", confidenceNote: e.confidenceNote, sourceId: e.sourceId ?? null,
    sensitivity: e.sensitivity ?? "personal", observedAt: e.observedAt ?? null,
  }).returning();
  await recordChange(tx, e.ownerId, "edge", created.id, "create", null, created, e.actor ?? "system");
  return created;
}

export async function retireEntityNode(tx: Tx, ownerId: string, refTable: string, refId: string, actor: string) {
  const node = await findEntityNode(tx, ownerId, refTable, refId);
  if (!node) return;
  await tx.update(schema.graphNodes).set({ status: "deleted", updatedAt: new Date() }).where(eq(schema.graphNodes.id, node.id));
  await tx.update(schema.graphEdges).set({ status: "retired" })
    .where(or(eq(schema.graphEdges.sourceNodeId, node.id), eq(schema.graphEdges.targetNodeId, node.id)));
  await recordChange(tx, ownerId, "node", node.id, "retire", node, { ...node, status: "deleted" }, actor);
}

async function recordChange(tx: Tx, ownerId: string, entity: "node" | "edge", entityId: string, change: string, before: unknown, after: unknown, actor: string) {
  await tx.insert(schema.graphChanges).values({ ownerId, entity, entityId, change, before: before as object, after: after as object, actor });
}

// ── Lecture ───────────────────────────────────────────────────────
export type GraphFilter = { types?: string[]; maxSensitivity?: Sensitivity; includeInferred?: boolean; limit?: number };

export async function loadGraph(ownerId: string, f: GraphFilter = {}) {
  const maxS = f.maxSensitivity ?? "private";
  const nodeRows = await db.select().from(schema.graphNodes).where(and(
    eq(schema.graphNodes.ownerId, ownerId), eq(schema.graphNodes.status, "active"),
    f.types?.length ? inArray(schema.graphNodes.type, f.types) : undefined,
  )).limit(f.limit ?? 3000);
  const nodes = nodeRows.filter((n) => canAccess(maxS, n.sensitivity));
  const ids = new Set(nodes.map((n) => n.id));
  const edgeRows = ids.size ? await db.select().from(schema.graphEdges).where(and(
    eq(schema.graphEdges.ownerId, ownerId), eq(schema.graphEdges.status, "active"),
    ne(schema.graphEdges.validation, "rejected"),
    f.includeInferred === false ? eq(schema.graphEdges.validation, "confirmed") : undefined,
  )) : [];
  const edges = edgeRows.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId) && canAccess(maxS, e.sensitivity));
  return { nodes, edges };
}

export async function neighborhood(ownerId: string, nodeId: string, depth = 1, maxSensitivity: Sensitivity = "private") {
  const { nodes, edges } = await loadGraph(ownerId, { maxSensitivity });
  const keep = new Set([nodeId]);
  let frontier = new Set([nodeId]);
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const e of edges) {
      if (frontier.has(e.sourceNodeId) && !keep.has(e.targetNodeId)) next.add(e.targetNodeId);
      if (frontier.has(e.targetNodeId) && !keep.has(e.sourceNodeId)) next.add(e.sourceNodeId);
    }
    next.forEach((n) => keep.add(n));
    frontier = next;
  }
  return { nodes: nodes.filter((n) => keep.has(n.id)), edges: edges.filter((e) => keep.has(e.sourceNodeId) && keep.has(e.targetNodeId)) };
}

/**
 * Chemins simples (non orientés) entre deux nœuds, longueur ≤ maxHops.
 * Chaque chemin renvoie la suite d'arêtes, pour pouvoir expliquer chaque saut.
 */
export function findPaths(nodes: NodeRow[], edges: EdgeRow[], from: string, to: string, maxHops = 4, maxPaths = 20) {
  const adj = new Map<string, EdgeRow[]>();
  for (const e of edges) {
    (adj.get(e.sourceNodeId) ?? adj.set(e.sourceNodeId, []).get(e.sourceNodeId)!).push(e);
    (adj.get(e.targetNodeId) ?? adj.set(e.targetNodeId, []).get(e.targetNodeId)!).push(e);
  }
  const results: { nodeIds: string[]; edges: EdgeRow[] }[] = [];
  const stack: { node: string; path: string[]; via: EdgeRow[] }[] = [{ node: from, path: [from], via: [] }];
  // BFS pour obtenir les chemins les plus courts en premier
  const queue = stack;
  while (queue.length && results.length < maxPaths) {
    const cur = queue.shift()!;
    if (cur.node === to && cur.via.length) { results.push({ nodeIds: cur.path, edges: cur.via }); continue; }
    if (cur.via.length >= maxHops) continue;
    for (const e of adj.get(cur.node) ?? []) {
      const nxt = e.sourceNodeId === cur.node ? e.targetNodeId : e.sourceNodeId;
      if (cur.path.includes(nxt)) continue;
      queue.push({ node: nxt, path: [...cur.path, nxt], via: [...cur.via, e] });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return results.map((r) => ({
    ...r,
    explanation: r.edges.map((e) => `${byId.get(e.sourceNodeId)?.label} —${e.type}${e.validation === "inferred" ? " (inférée)" : ""}→ ${byId.get(e.targetNodeId)?.label}`),
    containsInferred: r.edges.some((e) => e.validation === "inferred"),
  }));
}

export async function searchNodes(ownerId: string, q: string, limit = 10) {
  return db.select().from(schema.graphNodes).where(and(
    eq(schema.graphNodes.ownerId, ownerId), eq(schema.graphNodes.status, "active"),
    sql`(${schema.graphNodes.label} ILIKE ${"%" + q + "%"} OR similarity(${schema.graphNodes.label}, ${q}) > 0.3)`,
  )).orderBy(sql`similarity(${schema.graphNodes.label}, ${q}) DESC`).limit(limit);
}

/** Contrôle d'intégrité : nœuds synchronisés dont l'entité source a disparu, arêtes orphelines. */
export async function integrityReport(ownerId: string) {
  const tables = ["projects", "memories", "organizations", "contacts", "opportunities", "tasks", "knowledge_documents", "goals", "decisions", "calendar_events", "agent_definitions", "model_definitions", "plugin_definitions", "automations"];
  const orphanNodes: { table: string; count: number }[] = [];
  for (const t of tables) {
    const r = await db.execute(sql.raw(`SELECT count(*)::int AS c FROM graph_nodes n WHERE n.owner_id = '${ownerId.replace(/'/g, "")}' AND n.ref_table = '${t}' AND n.status = 'active' AND NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.id::text = n.ref_id)`));
    const c = (r.rows[0] as { c: number }).c;
    if (c) orphanNodes.push({ table: t, count: c });
  }
  const dangling = await db.execute(sql`SELECT count(*)::int AS c FROM graph_edges e JOIN graph_nodes s ON s.id = e.source_node_id JOIN graph_nodes t ON t.id = e.target_node_id WHERE e.owner_id = ${ownerId} AND e.status = 'active' AND (s.status = 'deleted' OR t.status = 'deleted')`);
  const missing = await db.execute(sql`
    SELECT 'projects' AS t, count(*)::int AS c FROM projects p WHERE p.owner_id = ${ownerId} AND NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.ref_table='projects' AND n.ref_id = p.id::text)
    UNION ALL SELECT 'organizations', count(*)::int FROM organizations o WHERE o.owner_id = ${ownerId} AND NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.ref_table='organizations' AND n.ref_id = o.id::text)
    UNION ALL SELECT 'memories', count(*)::int FROM memories m WHERE m.owner_id = ${ownerId} AND m.status='active' AND NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.ref_table='memories' AND n.ref_id = m.id::text AND n.status='active')`);
  return {
    orphanNodes,
    activeEdgesOnInactiveNodes: (dangling.rows[0] as { c: number }).c,
    entitiesWithoutNode: (missing.rows as { t: string; c: number }[]).filter((r) => r.c > 0),
  };
}
