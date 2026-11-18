import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { conversationMessages } from "@/core/orchestration/atlas";
import ChatPanel from "@/components/ChatPanel";
import { PageHeader } from "@/components/ui";

export default async function CommandPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const user = await requireUser();
  const { c } = await searchParams;
  const agents = await db.select({ id: schema.agentDefinitions.id, name: schema.agentDefinitions.name, implementation: schema.agentDefinitions.implementation }).from(schema.agentDefinitions).where(eq(schema.agentDefinitions.enabled, true));
  const convs = await db.select().from(schema.conversations).where(eq(schema.conversations.ownerId, user.id)).orderBy(desc(schema.conversations.updatedAt)).limit(15);
  const current = c ? await conversationMessages(user.id, c) : null;
  const approvals = await db.select({ id: schema.approvalRequests.id, actionSummary: schema.approvalRequests.actionSummary, preview: schema.approvalRequests.preview, status: schema.approvalRequests.status })
    .from(schema.approvalRequests).where(and(eq(schema.approvalRequests.ownerId, user.id), eq(schema.approvalRequests.status, "pending"))).orderBy(desc(schema.approvalRequests.createdAt));
  return (
    <>
      <PageHeader title="Command Center" subtitle="Discutez avec ATLAS, choisissez un agent, joignez des documents, suivez chaque étape et validez les actions."
        actions={<><Link href="/command" className="btn">Nouvelle conversation</Link>
          <details className="relative"><summary className="btn list-none">Historique</summary>
            <div className="absolute right-0 z-20 mt-1 w-80 card p-2 max-h-96 overflow-y-auto">{convs.map((x) => <Link key={x.id} href={`/command?c=${x.id}`} className="block px-2 py-1.5 rounded hover:bg-soft text-[13px] truncate">{x.title}</Link>)}</div>
          </details></>} />
      <ChatPanel key={c ?? "new"} agents={agents} conversationId={current?.conversation.id ?? null} pendingApprovals={approvals}
        initialMessages={(current?.messages ?? []).map((m) => ({ role: m.role as "user" | "assistant", content: m.content, runId: m.runId }))} />
    </>
  );
}
