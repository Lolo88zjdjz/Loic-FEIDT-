import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "../db/client";
import { sha256 } from "../security/crypto";
import { audit } from "../security/audit";

export const SESSION_COOKIE = "loic_os_session";
const SESSION_DAYS = 14;

export async function verifyCredentials(email: string, password: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase().trim()));
  // Comparaison même si l'utilisateur est absent, pour un temps de réponse homogène.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
  return ok && user ? user : null;
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt });
  await audit(db, { ownerId: userId, actor: "user", action: "auth.login" });
  return { token, expiresAt };
}

export async function getSessionUser(token: string | undefined | null) {
  if (!token) return null;
  const rows = await db.select({ user: schema.users }).from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, new Date())));
  return rows[0]?.user ?? null;
}

export async function destroySession(token: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
}

export const hashPassword = (p: string) => bcrypt.hash(p, 12);
