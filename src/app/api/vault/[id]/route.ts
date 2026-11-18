import { apiUser } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { readOriginal } from "@/core/knowledge/service";

/** Téléchargement de l'original (toujours en pièce jointe, jamais rendu inline). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(); if (!user) return unauthorized();
  try {
    const { doc, data } = await readOriginal(user.id, (await params).id);
    return new Response(new Uint8Array(data), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.filename)}`, "x-content-type-options": "nosniff" } });
  } catch (e) { return apiError(e); }
}
