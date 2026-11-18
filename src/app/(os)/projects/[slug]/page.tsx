import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { getProjectBySlug, openTasks, createDecision, listDecisions } from "@/core/projects/service";
import { findEntityNode } from "@/core/graph/service";
import { Badge, Card, Empty, fmtDate, PageHeader, statusTone } from "@/components/ui";

async function addDecision(f: FormData) {
  "use server"; const u = await requireUser();
  await createDecision(u.id, { problem: String(f.get("problem")), options: String(f.get("options") ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
    arguments: (f.get("arguments") as string) || null, constraints: (f.get("constraints") as string) || null, decision: (f.get("decision") as string) || null,
    decidedOn: (f.get("decidedOn") as string) || null, projectId: String(f.get("projectId")) });
  revalidatePath(`/projects/${f.get("slug")}`);
}

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const p = await getProjectBySlug(user.id, (await params).slug);
  if (!p) notFound();
  const [tasks, goals, mems, opps, docs, decisions, node] = await Promise.all([
    openTasks(user.id, p.id),
    db.select().from(schema.goals).where(eq(schema.goals.projectId, p.id)),
    db.select().from(schema.memories).where(and(eq(schema.memories.projectId, p.id), eq(schema.memories.status, "active"))).orderBy(desc(schema.memories.observedAt)),
    db.select({ o: schema.opportunities, org: schema.organizations.name }).from(schema.opportunities).leftJoin(schema.organizations, eq(schema.organizations.id, schema.opportunities.organizationId)).where(eq(schema.opportunities.projectId, p.id)),
    db.select().from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.projectId, p.id)),
    listDecisions(user.id).then((d) => d.filter((x) => x.projectId === p.id)),
    findEntityNode(db, user.id, "projects", p.id),
  ]);
  return (
    <>
      <PageHeader title={p.name} subtitle={p.description} actions={node && <Link className="btn" href={`/brain?focus=${node.id}`}>Voir dans le Neural Brain</Link>} />
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title={`Tâches (${tasks.length})`}>{tasks.length ? <ul className="space-y-1 text-[13px]">{tasks.map(({ task: t }) => <li key={t.id} className="flex justify-between gap-2"><span>{t.title}</span><span className="text-faint text-[12px]">{t.dueAt ? fmtDate(t.dueAt) : `P${t.priority}`}</span></li>)}</ul> : <Empty>Aucune tâche ouverte.</Empty>}</Card>
        <Card title="Objectifs">{goals.length ? <ul className="space-y-1 text-[13px]">{goals.map((g) => <li key={g.id}><b>{g.title}</b> <span className="text-faint">({g.horizon})</span>{g.description && <div className="text-muted text-[12px]">{g.description}</div>}</li>)}</ul> : <Empty>Aucun objectif.</Empty>}</Card>
        {opps.length > 0 && <Card title={`Opportunités (${opps.length})`} className="lg:col-span-2"><div className="flex flex-wrap gap-2">{opps.map(({ o, org }) => <span key={o.id} className="text-[12px] border border-line rounded px-2 py-1">{org} · <Badge tone={statusTone(o.stage)}>{o.stage}</Badge></span>)}</div></Card>}
        <Card title={`Mémoire du projet (${mems.length})`}>{mems.length ? <ul className="space-y-1.5 text-[13px]">{mems.map((m) => <li key={m.id}>{m.content} <span className="text-faint text-[11px]">({m.observedAt})</span></li>)}</ul> : <Empty>Aucun souvenir rattaché.</Empty>}</Card>
        <Card title="Documents">{docs.length ? <ul className="text-[13px]">{docs.map((d) => <li key={d.id}>{d.title}</li>)}</ul> : <Empty>Aucun document rattaché.</Empty>}</Card>
        <Card title="Decision Intelligence" className="lg:col-span-2">
          {decisions.map((d) => <div key={d.id} className="border-t border-line py-2 text-[13px]"><b>{d.problem}</b>{d.decision && <> → {d.decision}</>} <span className="text-faint text-[12px]">{d.decidedOn ?? ""}</span>{(d.options as string[]).length > 0 && <div className="text-muted text-[12px]">Options : {(d.options as string[]).join(" · ")}</div>}</div>)}
          <form action={addDecision} className="grid md:grid-cols-2 gap-2 mt-3">
            <input type="hidden" name="projectId" value={p.id} /><input type="hidden" name="slug" value={p.slug} />
            <input name="problem" className="input" placeholder="Problème / question" required /><input name="decision" className="input" placeholder="Décision (si prise)" />
            <textarea name="options" className="input" rows={2} placeholder="Options (une par ligne)" /><textarea name="arguments" className="input" rows={2} placeholder="Arguments" />
            <input name="constraints" className="input" placeholder="Contraintes" /><input type="date" name="decidedOn" className="input" />
            <button className="btn w-fit">Enregistrer la décision</button>
          </form>
        </Card>
      </div>
    </>
  );
}
