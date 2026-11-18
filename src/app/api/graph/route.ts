import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { apiUser } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { loadGraph, neighborhood } from "@/core/graph/service";
import { db } from "@/core/db/client";

export async function GET(req: Request) {
  const user = await apiUser(); if (!user) return unauthorized();
  try {
    const u = new URL(req.url);
    const types = u.searchParams.get("types")?.split(",").filter(Boolean);
    const focus = u.searchParams.get("focus");
    const includeInferred = u.searchParams.get("inferred") !== "0";
    const includeSensitive = u.searchParams.get("sensitive") === "1";
    const since = u.searchParams.get("since"); const until = u.searchParams.get("until");
    const limit = Math.min(Number(u.searchParams.get("limit") ?? 1500), 5000);
    const maxSensitivity = includeSensitive ? "sensitive" : "private";
    let g = focus ? await neighborhood(user.id, focus, Number(u.searchParams.get("depth") ?? 2), maxSensitivity) : await loadGraph(user.id, { types, includeInferred, maxSensitivity, limit });
    if (focus && types?.length) { const keep = new Set(g.nodes.filter((n) => types.includes(n.type) || n.id === focus).map((n) => n.id)); g = { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.sourceNodeId) && keep.has(e.targetNodeId)) }; }
    if (!includeInferred) g.edges = g.edges.filter((e) => e.validation === "confirmed");
    if (since || until) {
      const s = since ? new Date(since) : new Date(0); const t = until ? new Date(until + "T23:59:59") : new Date(8e15);
      const inRange = (n: (typeof g.nodes)[number]) => { const d = new Date(((n.properties as Record<string, string>)?.observedAt) ?? n.createdAt); return d >= s && d <= t; };
      const keep = new Set(g.nodes.filter((n) => inRange(n) || n.type === "Project" || n.type === "Person").map((n) => n.id));
      g = { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.sourceNodeId) && keep.has(e.targetNodeId)) };
    }
    // Agents actifs : exécutions démarrées dans la dernière heure (événements réels uniquement)
    const active = (await db.execute(sql`SELECT DISTINCT agent_id FROM agent_runs WHERE owner_id = ${user.id} AND created_at > now() - interval '1 hour'`)).rows.map((r) => (r as { agent_id: string }).agent_id);
    const deg = new Map<string, number>();
    for (const e of g.edges) { deg.set(e.sourceNodeId, (deg.get(e.sourceNodeId) ?? 0) + 1); deg.set(e.targetNodeId, (deg.get(e.targetNodeId) ?? 0) + 1); }
    const dayAgo = Date.now() - 86400_000;
    return NextResponse.json({
      nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, degree: deg.get(n.id) ?? 0, fresh: new Date(n.createdAt).getTime() > dayAgo && n.updatedAt.getTime() > dayAgo,
        active: n.type === "Agent" && active.includes(n.refId ?? ""), sensitivity: n.sensitivity })),
      edges: g.edges.map((e) => ({ id: e.id, source: e.sourceNodeId, target: e.targetNodeId, type: e.type, validation: e.validation })),
      truncated: g.nodes.length >= limit,
    });
  } catch (e) { return apiError(e); }
}
