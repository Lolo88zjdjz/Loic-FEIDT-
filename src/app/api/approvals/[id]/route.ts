import { NextResponse } from "next/server";
import { z } from "zod";
import { apiUser } from "@/lib/auth";
import { apiError, sameOrigin, unauthorized } from "@/lib/http";
import { decideApproval } from "@/core/orchestration/engine";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(); if (!user) return unauthorized();
  if (!sameOrigin(req)) return NextResponse.json({ error: "Origine refusée" }, { status: 403 });
  try {
    const { decision } = z.object({ decision: z.enum(["approve", "reject"]) }).parse(await req.json());
    return NextResponse.json(await decideApproval(user.id, (await params).id, decision));
  } catch (e) { return apiError(e); }
}
