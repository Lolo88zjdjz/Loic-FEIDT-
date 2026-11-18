import { NextResponse } from "next/server";
import { and, asc, eq, or, inArray } from "drizzle-orm";
import { apiUser } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { db, schema } from "@/core/db/client";

/** Execution Graph : reflète uniquement les étapes réellement enregistrées. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(); if (!user) return unauthorized();
  try {
    const { id } = await params;
    const runs = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.ownerId, user.id), or(eq(schema.agentRuns.id, id), eq(schema.agentRuns.rootRunId, id))));
    if (!runs.length) return NextResponse.json({ error: "introuvable" }, { status: 404 });
    const steps = await db.select().from(schema.agentRunSteps).where(inArray(schema.agentRunSteps.runId, runs.map((r) => r.id))).orderBy(asc(schema.agentRunSteps.createdAt));
    const tools = await db.select().from(schema.toolInvocations).where(inArray(schema.toolInvocations.runId, runs.map((r) => r.id))).orderBy(asc(schema.toolInvocations.createdAt));
    const usage = await db.select().from(schema.modelUsage).where(inArray(schema.modelUsage.runId, runs.map((r) => r.id)));
    return NextResponse.json({ runs, steps, tools, usage });
  } catch (e) { return apiError(e); }
}
