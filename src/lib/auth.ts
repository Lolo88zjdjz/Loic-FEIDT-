import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, SESSION_COOKIE } from "@/core/auth/session";

export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUser(token);
}
export async function requireUser() {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}
/** Pour les routes API : renvoie l'utilisateur ou null (la route répond 401). */
export const apiUser = currentUser;
