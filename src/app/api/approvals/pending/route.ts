import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { apiUser } from "@/lib/auth";
import { unauthorized } from "@/lib/http";
import { db, schema } from "@/core/db/client";

export async function GET() {
  const user = await apiUser(); if (!user) return unauthorized();
  const approvals = await db.select({ id: schema.approvalRequests.id, actionSummary: schema.approvalRequests.actionSummary, preview: schema.approvalRequests.preview, status: schema.approvalRequests.status })
    .from(schema.approvalRequests).where(and(eq(schema.approvalRequests.ownerId, user.id), eq(schema.approvalRequests.status, "pending"))).orderBy(desc(schema.approvalRequests.createdAt));
  return NextResponse.json({ approvals });
}
