import { NextResponse } from "next/server";
import { z } from "zod";
import { apiUser } from "@/lib/auth";
import { apiError, sameOrigin, unauthorized } from "@/lib/http";
import { handleMessage } from "@/core/orchestration/atlas";

const body = z.object({ text: z.string().trim().min(1).max(8000), conversationId: z.string().uuid().nullable().optional(), agentId: z.string().max(40).nullable().optional() });

export async function POST(req: Request) {
  const user = await apiUser(); if (!user) return unauthorized();
  if (!sameOrigin(req)) return NextResponse.json({ error: "Origine refusée" }, { status: 403 });
  try {
    const b = body.parse(await req.json());
    return NextResponse.json(await handleMessage(user.id, b.text, { conversationId: b.conversationId, agentId: b.agentId || null }));
  } catch (e) { return apiError(e); }
}
