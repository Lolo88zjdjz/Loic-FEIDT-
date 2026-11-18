import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/core/shared";
import { redactString } from "@/core/security/redact";

/** Protection CSRF pour les routes API mutantes : l'origine doit correspondre à l'hôte. */
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // requêtes same-origin sans en-tête (fetch serveur, tests)
  try { return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host")); } catch { return false; }
}

export function apiError(e: unknown) {
  if (e instanceof ZodError) return NextResponse.json({ error: "Entrée invalide", issues: e.issues }, { status: 400 });
  if (e instanceof AppError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  console.error(e);
  return NextResponse.json({ error: redactString((e as Error).message ?? "Erreur interne") }, { status: 500 });
}
export const unauthorized = () => NextResponse.json({ error: "Non authentifié" }, { status: 401 });
