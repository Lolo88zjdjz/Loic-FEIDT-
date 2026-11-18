import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { recentAutomationRuns } from "@/core/workflows/automations";
import { enqueueAutomation } from "@/core/workflows/queue";
import { audit } from "@/core/security/audit";
import { Markdown } from "@/components/Markdown";
import { Badge, Card, Empty, fmtDate, PageHeader, statusTone } from "@/components/ui";

async function toggle(f: FormData) {
  "use server"; const u = await requireUser();
  await db.update(schema.automations).set({ enabled: f.get("enabled") === "1", updatedAt: new Date() }).where(and(eq(schema.automations.id, String(f.get("id"))), eq(schema.automations.ownerId, u.id)));
  revalidatePath("/automations");
}
async function setCron(f: FormData) {
  "use server"; const u = await requireUser();
  const cron = String(f.get("cron")).trim();
  if (!/^(\S+\s+){4}\S+$/.test(cron)) throw new Error("Expression cron invalide (5 champs)");
  await db.update(schema.automations).set({ cron, updatedAt: new Date() }).where(and(eq(schema.automations.id, String(f.get("id"))), eq(schema.automations.ownerId, u.id)));
  await audit(db, { ownerId: u.id, actor: "user", action: "automation.cron", entityId: String(f.get("id")), details: { cron } });
  revalidatePath("/automations");
}
async function runNow(f: FormData) {
  "use server"; const u = await requireUser();
  await enqueueAutomation(String(f.get("id")));
  await audit(db, { ownerId: u.id, actor: "user", action: "automation.enqueue", entityId: String(f.get("id")) });
  revalidatePath("/automations");
}

export default async function AutomationsPage() {
  const user = await requireUser();
  const autos = await db.select().from(schema.automations).where(eq(schema.automations.ownerId, user.id));
  const runs = await recentAutomationRuns(user.id, 25);
  const [hb] = await db.select().from(schema.userPreferences).where(and(eq(schema.userPreferences.ownerId, user.id), eq(schema.userPreferences.key, "system.worker_heartbeat")));
  const workerAlive = hb && Date.now() - new Date(String(hb.value)).getTime() < 90_000;
  return (
    <>
      <PageHeader title="Automations" subtitle={<>Planifiées et exécutées par le worker pg-boss (file durable dans PostgreSQL). Worker : {workerAlive ? <span className="text-ok">actif</span> : <span className="text-bad">arrêté — lancez <code>pnpm worker</code> ; les jobs restent en file</span>}{hb ? ` (dernier signal ${fmtDate(String(hb.value), true)})` : ""}.</>} />
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
        {autos.map((a) => (
          <div key={a.id} className="card p-4 space-y-2" data-testid="automation">
            <div className="flex items-center gap-2"><span className="font-semibold">{a.name}</span>{a.requiresLlm && <Badge tone={process.env.ANTHROPIC_API_KEY ? "info" : "warn"}>clé API requise</Badge>}<span className="ml-auto"><Badge tone={a.enabled ? "ok" : "neutral"}>{a.enabled ? "active" : "désactivée"}</Badge></span></div>
            <p className="text-[12px] text-muted">{a.description}</p>
            <form action={setCron} className="flex gap-2"><input type="hidden" name="id" value={a.id} /><input name="cron" defaultValue={a.cron} className="input font-mono text-[12px]" /><button className="btn text-[12px]">Planifier</button></form>
            <div className="text-[11px] text-faint">Fuseau {a.timezone} · dernière exécution : {a.lastRunAt ? fmtDate(a.lastRunAt, true) : "jamais"}</div>
            <div className="flex gap-2">
              <form action={runNow}><input type="hidden" name="id" value={a.id} /><button className="btn text-[12px]">Exécuter maintenant</button></form>
              <form action={toggle}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="enabled" value={a.enabled ? "0" : "1"} /><button className="btn text-[12px]">{a.enabled ? "Désactiver" : "Activer"}</button></form>
            </div>
          </div>
        ))}
      </div>
      <Card title="Exécutions récentes">
        {runs.length ? <div className="space-y-2">{runs.map(({ run, name }) => (
          <details key={run.id} className="border-t border-line pt-2"><summary className="flex gap-2 items-center text-[13px] cursor-pointer"><Badge tone={statusTone(run.status)}>{run.status}</Badge><span>{name}</span><span className="text-faint text-[12px]">{run.trigger} · tentative {run.attempt} · {fmtDate(run.startedAt, true)}</span></summary>
            <div className="mt-2 pl-2 text-[13px]">{run.error ? <p className="text-bad">{run.error}</p> : <Markdown text={String((run.output as { body?: string })?.body ?? "")} />}</div></details>))}</div> : <Empty>Aucune exécution enregistrée.</Empty>}
      </Card>
    </>
  );
}
