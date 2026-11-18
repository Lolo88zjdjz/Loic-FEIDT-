import { and, count, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { db, schema } from "@/core/db/client";
import { aiStatus } from "@/core/llm/status";

export const dynamic = "force-dynamic";

export default async function OsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [{ n }] = await db.select({ n: count() }).from(schema.approvalRequests).where(and(eq(schema.approvalRequests.ownerId, user.id), eq(schema.approvalRequests.status, "pending")));
  const ai = await aiStatus(user.id);
  return (
    <div className="flex min-h-screen">
      <Sidebar pending={n} llm={ai.freeAvailable || (ai.policy === "allow_paid" && ai.anthropicConfigured)} label={`${ai.label}${ai.policy === "free_only" ? " · 100 % gratuit" : " · payant autorisé"}`} />
      <main className="flex-1 min-w-0 px-4 md:px-8 py-6 md:py-8 pt-14 md:pt-8 max-w-[1400px]">{children}</main>
    </div>
  );
}
