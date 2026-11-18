import { NextResponse } from "next/server";
import { and, eq, or, desc } from "drizzle-orm";
import { apiUser } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { db, schema } from "@/core/db/client";

/** Détail d'un nœud ou d'une arête : propriétés, provenance, source, historique. */
export async function GET(req: Request) {
  const user = await apiUser(); if (!user) return unauthorized();
  try {
    const u = new URL(req.url);
    const nodeId = u.searchParams.get("id"); const edgeId = u.searchParams.get("edge");
    if (edgeId) {
      const [e] = await db.select().from(schema.graphEdges).where(and(eq(schema.graphEdges.id, edgeId), eq(schema.graphEdges.ownerId, user.id)));
      if (!e) return NextResponse.json({ error: "introuvable" }, { status: 404 });
      const ends = await db.select().from(schema.graphNodes).where(or(eq(schema.graphNodes.id, e.sourceNodeId), eq(schema.graphNodes.id, e.targetNodeId)));
      const source = e.sourceId ? (await db.select().from(schema.sources).where(eq(schema.sources.id, e.sourceId)))[0] : null;
      const history = await db.select().from(schema.graphChanges).where(eq(schema.graphChanges.entityId, e.id)).orderBy(desc(schema.graphChanges.createdAt));
      return NextResponse.json({ edge: e, from: ends.find((n) => n.id === e.sourceNodeId)?.label, to: ends.find((n) => n.id === e.targetNodeId)?.label, source, history });
    }
    const [n] = await db.select().from(schema.graphNodes).where(and(eq(schema.graphNodes.id, nodeId ?? ""), eq(schema.graphNodes.ownerId, user.id)));
    if (!n) return NextResponse.json({ error: "introuvable" }, { status: 404 });
    const edges = await db.select().from(schema.graphEdges).where(and(eq(schema.graphEdges.status, "active"), or(eq(schema.graphEdges.sourceNodeId, n.id), eq(schema.graphEdges.targetNodeId, n.id))));
    const otherIds = edges.map((e) => (e.sourceNodeId === n.id ? e.targetNodeId : e.sourceNodeId));
    const others = otherIds.length ? await db.select({ id: schema.graphNodes.id, label: schema.graphNodes.label, type: schema.graphNodes.type }).from(schema.graphNodes).where(or(...otherIds.map((id) => eq(schema.graphNodes.id, id)))) : [];
    const source = n.sourceId ? (await db.select().from(schema.sources).where(eq(schema.sources.id, n.sourceId)))[0] : null;
    const history = await db.select().from(schema.graphChanges).where(eq(schema.graphChanges.entityId, n.id)).orderBy(desc(schema.graphChanges.createdAt)).limit(10);
    const link = n.refTable === "projects" ? `/projects` : n.refTable === "memories" ? `/memory?focus=${n.refId}` : n.refTable === "organizations" || n.refTable === "contacts" || n.refTable === "opportunities" ? `/crm` :
      n.refTable === "agent_definitions" ? `/agents/${n.refId}` : n.refTable === "knowledge_documents" ? `/vault` : n.refTable === "tasks" ? `/projects` : n.refTable === "calendar_events" ? "/calendar" : null;
    return NextResponse.json({ node: n, source, history, link,
      relations: edges.map((e) => ({ id: e.id, type: e.type, direction: e.sourceNodeId === n.id ? "out" : "in", other: others.find((o) => o.id === (e.sourceNodeId === n.id ? e.targetNodeId : e.sourceNodeId)), validation: e.validation, provenance: e.provenance, confidenceNote: e.confidenceNote })) });
  } catch (e) { return apiError(e); }
}
