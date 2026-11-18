import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { decideApproval } from "@/core/orchestration/engine";
import RunRow from "@/components/RunRow";
import { Badge, Card, Empty, fmtDate, PageHeader, statusTone, usd } from "@/components/ui";
import { Markdown } from "@/components/Markdown";

async function decide(f: FormData) { "use server"; const u = await requireUser(); await decideApproval(u.id, String(f.get("id")), String(f.get("decision")) as "approve"); revalidatePath("/activity"); }
async function readAll() { "use server"; const u = await requireUser(); await db.update(schema.notifications).set({ readAt: new Date() }).where(and(eq(schema.notifications.ownerId, u.id), isNull(schema.notifications.readAt))); revalidatePath("/activity"); }

export default async function ActivityPage() {
  const user = await requireUser();
  const [runs, approvals, auditRows, notifs] = await Promise.all([
    db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.ownerId, user.id), isNull(schema.agentRuns.parentRunId))).orderBy(desc(schema.agentRuns.createdAt)).limit(40),
    db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.ownerId, user.id)).orderBy(desc(schema.approvalRequests.createdAt)).limit(30),
    db.select().from(schema.auditEvents).where(eq(schema.auditEvents.ownerId, user.id)).orderBy(desc(schema.auditEvents.createdAt)).limit(60),
    db.select().from(schema.notifications).where(eq(schema.notifications.ownerId, user.id)).orderBy(desc(schema.notifications.createdAt)).limit(20),
  ]);
  return (
    <>
      <PageHeader title="Activity" subtitle="Historique réel des agents (cliquez une exécution pour son Execution Graph), approbations, notifications et journal d'audit." />
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Approbations">
          {approvals.length ? approvals.map((a) => (
            <div key={a.id} className="border-t border-line py-2 text-[13px]" data-testid="approval-row">
              <div className="flex gap-2 items-center"><Badge tone={statusTone(a.status)}>{a.status}</Badge><span className="font-medium">{a.actionSummary}</span><span className="text-faint text-[11px] ml-auto">{a.agentId} · niveau {a.permissionLevel}</span></div>
              {a.preview && <details className="mt-1"><summary className="text-[12px] text-muted cursor-pointer">Prévisualisation</summary><pre className="text-[12px] whitespace-pre-wrap bg-soft rounded p-2 mt-1">{a.preview}</pre></details>}
              {a.result ? <div className="text-[12px] text-muted mt-1">Résultat : {JSON.stringify(a.result).slice(0, 200)}</div> : null}
              {a.status === "pending" && <div className="flex gap-2 mt-2">
                <form action={decide}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="decision" value="approve" /><button className="btn text-[12px]">Approuver</button></form>
                <form action={decide}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="decision" value="reject" /><button className="btn btn-danger text-[12px]" data-testid="reject-activity">Refuser</button></form></div>}
            </div>)) : <Empty>Aucune demande.</Empty>}
        </Card>
        <Card title="Notifications" right={<form action={readAll}><button className="text-[12px] text-accent">Tout marquer lu</button></form>}>
          {notifs.length ? notifs.map((n) => <details key={n.id} className="border-t border-line py-1.5"><summary className="text-[13px] cursor-pointer">{!n.readAt && <span className="text-accent">● </span>}{n.title} <span className="text-faint text-[11px]">{fmtDate(n.createdAt, true)}</span></summary><div className="text-[13px] mt-1"><Markdown text={n.body} /></div></details>) : <Empty>Aucune notification.</Empty>}
        </Card>
        <Card title="Exécutions des agents" className="lg:col-span-2">
          {runs.length ? runs.map((r) => (
            <RunRow key={r.id} id={r.id}><div className="flex gap-2 items-center text-[13px]"><Badge tone={statusTone(r.status)}>{r.status}</Badge><span className="font-mono text-[11px] text-faint">{r.agentId}</span><span className="truncate flex-1">{r.objective}</span>
              <span className="text-faint text-[12px]">{r.mode}{r.modelId ? ` · ${r.modelId}` : ""} · {usd(r.costUsd)} · {r.durationMs ?? "?"} ms · {fmtDate(r.createdAt, true)}</span></div></RunRow>)) : <Empty>Aucune exécution.</Empty>}
        </Card>
        <Card title="Journal d'audit" className="lg:col-span-2">
          <table className="w-full text-[12px]"><tbody>{auditRows.map((a) => <tr key={a.id} className="border-t border-line"><td className="py-1 text-faint whitespace-nowrap">{fmtDate(a.createdAt, true)}</td><td className="font-mono">{a.actor}</td><td>{a.action}</td><td className="text-faint">{a.entityType} {a.entityId?.slice(0, 8)}</td><td className="text-muted truncate max-w-[360px]">{JSON.stringify(a.details) === "{}" ? "" : JSON.stringify(a.details).slice(0, 140)}</td></tr>)}</tbody></table>
        </Card>
      </div>
    </>
  );
}
