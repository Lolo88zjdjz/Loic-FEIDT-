import { db, schema } from "@/core/db/client";
import { syncRegistries } from "@/core/registry-sync";

let n = 0;
export async function makeUser() {
  const [u] = await db.insert(schema.users).values({ email: `test${Date.now()}-${n++}@example.test`, passwordHash: "x", displayName: "Test" }).returning();
  await syncRegistries(u.id);
  return u;
}
