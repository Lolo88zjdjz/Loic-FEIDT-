import { NextResponse } from "next/server";
import { apiUser } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { findPaths, loadGraph } from "@/core/graph/service";

export async function GET(req: Request) {
  const user = await apiUser(); if (!user) return unauthorized();
  try {
    const u = new URL(req.url);
    const from = u.searchParams.get("from") ?? ""; const to = u.searchParams.get("to") ?? "";
    const g = await loadGraph(user.id, { maxSensitivity: "private" });
    const paths = findPaths(g.nodes, g.edges, from, to, Math.min(Number(u.searchParams.get("hops") ?? 4), 5), 15);
    return NextResponse.json({ paths: paths.map((p) => ({ nodeIds: p.nodeIds, edgeIds: p.edges.map((e) => e.id), explanation: p.explanation, containsInferred: p.containsInferred })) });
  } catch (e) { return apiError(e); }
}
