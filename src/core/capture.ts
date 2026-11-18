/** Universal Capture : dépôt rapide + suggestion de classement déterministe (validée par l'utilisateur). */
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import { createTask } from "./projects/service";
import { createMemory } from "./memory/service";
import { audit } from "./security/audit";

export function suggestKind(text: string): { kind: string; why: string } {
  if (/https?:\/\/\S+/.test(text)) return { kind: "link", why: "contient une URL" };
  if (/\b[\w.+-]+@[\w-]+\.[\w.]+\b/.test(text) || /^(contact|rencontr[ée])/i.test(text)) return { kind: "contact", why: "adresse e-mail ou mention de contact" };
  if (/^(todo|à faire|a faire|penser à|rappel|relancer|envoyer|appeler|préparer)\b/i.test(text) || /\bavant (le|lundi|mardi|mercredi|jeudi|vendredi)\b/i.test(text)) return { kind: "task", why: "verbe d'action / échéance" };
  if (/^(idée|et si|pourquoi pas)\b/i.test(text)) return { kind: "idea", why: "formulée comme une idée" };
  return { kind: "note", why: "par défaut" };
}

export async function capture(ownerId: string, content: string) {
  const s = suggestKind(content);
  const [c] = await db.insert(schema.captures).values({ ownerId, content: content.slice(0, 4000), suggestedKind: s.kind, suggestion: s }).returning();
  return c;
}
export async function inbox(ownerId: string) {
  return db.select().from(schema.captures).where(and(eq(schema.captures.ownerId, ownerId), eq(schema.captures.status, "inbox"))).orderBy(desc(schema.captures.createdAt)).limit(10);
}
export async function fileCapture(ownerId: string, id: string, as: "task" | "memory" | "discard") {
  const [c] = await db.select().from(schema.captures).where(and(eq(schema.captures.ownerId, ownerId), eq(schema.captures.id, id)));
  if (!c) return;
  if (as === "task") await createTask(ownerId, { title: c.content.slice(0, 300) });
  if (as === "memory") await createMemory(ownerId, { content: c.content, type: "semantic", category: "identity", confidenceStatus: "user_confirmed", tags: ["capture"] });
  await db.update(schema.captures).set({ status: as === "discard" ? "discarded" : "filed", filedAs: as }).where(eq(schema.captures.id, id));
  await audit(db, { ownerId, actor: "user", action: "capture.filed", entityId: id, details: { as } });
}
