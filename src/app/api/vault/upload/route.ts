import { NextResponse } from "next/server";
import { apiUser } from "@/lib/auth";
import { apiError, sameOrigin, unauthorized } from "@/lib/http";
import { importDocument } from "@/core/knowledge/service";

export async function POST(req: Request) {
  const user = await apiUser(); if (!user) return unauthorized();
  if (!sameOrigin(req)) return NextResponse.json({ error: "Origine refusée" }, { status: 403 });
  try {
    const form = await req.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (!files.length) return NextResponse.json({ error: "Aucun fichier" }, { status: 400 });
    const projectId = (form.get("projectId") as string) || null;
    const sensitivity = ((form.get("sensitivity") as string) || "personal") as "personal";
    const results = [];
    for (const f of files) {
      const r = await importDocument(user.id, { filename: f.name, mimeType: f.type, data: Buffer.from(await f.arrayBuffer()), projectId, sensitivity });
      results.push({ id: r.document.id, title: r.document.title, status: r.document.status, duplicate: r.duplicate, note: r.document.extractionError, injectionSuspected: r.injectionFlags.length > 0 });
    }
    return NextResponse.json({ results });
  } catch (e) { return apiError(e); }
}
