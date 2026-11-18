import Link from "next/link";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { listProjects, openTasks, eventsBetween } from "@/core/projects/service";
import { budgetState, getMode } from "@/core/model-router/router";
import { aiStatus } from "@/core/llm/status";
import { staleOpportunities } from "@/core/crm/service";
import BrainGraph from "@/components/BrainGraph";
import { Badge, Card, Empty, fmtDate, PageHeader, Stat, statusTone, usd } from "@/components/ui";
import { revalidatePath } from "next/cache";
import { capture, fileCapture, inbox } from "@/core/capture";

async function doCapture(f: FormData) { "use server"; const u = await requireUser(); const t = String(f.get("content") ?? "").trim(); if (t) await capture(u.id, t); revalidatePath("/"); }
async function doFile(f: FormData) { "use server"; const u = await requireUser(); await fileCapture(u.id, String(f.get("id")), String(f.get("as")) as "task"); revalidatePath("/"); }

export default async function Dashboard() {
  const user = await requireUser();
  const [projects, tasks, events, budget, mode, stale, agents, autos, runs, notifs] = await Promise.all([
    listProjects(user.id), openTasks(user.id), eventsBetween(user.id, new Date(), new Date(Date.now() + 90 * 86400_000)), budgetState(user.id), getMode(user.id),
    staleOpportunities(user.id, 10),
    db.select().from(schema.agentDefinitions),
    db.select().from(schema.automations).where(eq(schema.automations.ownerId, user.id)),
    db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.ownerId, user.id), sql`${schema.agentRuns.parentRunId} IS NULL`)).orderBy(desc(schema.agentRuns.createdAt)).limit(6),
    db.select().from(schema.notifications).where(and(eq(schema.notifications.ownerId, user.id), gte(schema.notifications.createdAt, new Date(Date.now() - 7 * 86400_000)))).orderBy(desc(schema.notifications.createdAt)).limit(4),
  ]);
  const captures = await inbox(user.id);
  const priorities = tasks.filter((t) => t.task.priority === 1 || (t.task.dueAt && t.task.dueAt.getTime() < Date.now() + 7 * 86400_000)).slice(0, 6);
  const hour = new Date().getHours();
  const suggestions: string[] = [];
  const llmRuns = runs.filter((r) => r.mode === "llm").length;
  const ai = await aiStatus(user.id);
  if (!ai.freeAvailable) suggestions.push("Aucun modèle gratuit disponible : lancez Ollama avec un modèle local (README → IA gratuite) pour les demandes ouvertes. Les intentions reconnues fonctionnent déjà sans IA.");
  else suggestions.push(`${ai.label}. Politique ${ai.policy === "free_only" ? "100 % gratuit : aucun appel payant possible" : "payant autorisé"}. Limite : pas de recherche web en mode gratuit.`);
  if (budget.monthUsd > budget.limits.monthUsd * 0.8) suggestions.push(`80 % du budget mensuel consommé : passez en mode ECO (actuel : ${mode}).`);
  if (llmRuns === 0 && ai.freeAvailable) suggestions.push("Aucune donnée LLM mesurée : TOKEN MASTER proposera des optimisations après les premiers appels.");
  return (
    <>
      <PageHeader title={`${hour < 18 ? "Bonjour" : "Bonsoir"} Loïc`} subtitle={`${new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} — voici votre environnement.`}
        actions={<Link href="/command" className="btn btn-primary">Parler à ATLAS</Link>} />
      <Card title="Universal Capture" className="mb-4">
        <form action={doCapture} className="flex gap-2"><input name="content" className="input" placeholder="Idée, note, lien, tâche, contact… (ATLAS suggère un classement)" data-testid="capture-input" /><button className="btn btn-primary">Capturer</button></form>
        {captures.length > 0 && <ul className="mt-3 space-y-1.5">{captures.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 text-[13px]"><Badge tone="accent">{c.suggestedKind}</Badge><span className="flex-1">{c.content}</span><span className="text-faint text-[11px]">suggestion : {(c.suggestion as { why: string })?.why}</span>
            {(["task", "memory", "discard"] as const).map((as) => <form key={as} action={doFile}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="as" value={as} /><button className="btn text-[11px]">{as === "task" ? "→ tâche" : as === "memory" ? "→ mémoire" : "ignorer"}</button></form>)}</li>))}</ul>}
      </Card>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="Tâches ouvertes" value={tasks.length} hint={`${tasks.filter((t) => t.task.dueAt && t.task.dueAt < new Date()).length} en retard`} />
        <Stat label="Projets actifs" value={projects.filter((p) => p.status === "active").length} />
        <Stat label="Dépenses IA (mois)" value={usd(budget.monthUsd)} hint={`plafond ${budget.limits.monthUsd} $ · mode ${mode}`} />
        <Stat label="Agents opérationnels" value={`${agents.filter((a) => a.implementation === "operational").length}/${agents.length}`} hint="les autres requièrent une clé API" />
      </div>
      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="Priorités" className="lg:col-span-1">
          {priorities.length ? <ul className="space-y-2">{priorities.map((t) => <li key={t.task.id} className="text-[13px]"><div>{t.task.title}</div><div className="text-faint text-[12px]">{t.projectName ?? "Sans projet"}{t.task.dueAt ? ` · ${fmtDate(t.task.dueAt)}` : ""}</div></li>)}</ul> : <Empty>Aucune priorité urgente.</Empty>}
        </Card>
        <Card title="Neural Brain" className="lg:col-span-2" right={<Link className="text-[12px] text-accent" href="/brain">Ouvrir →</Link>}>
          <BrainGraph compact initialTypes={["Person", "Project", "Organization", "Goal", "Skill", "Topic", "Event"]} />
        </Card>
        <Card title="Projets">
          <ul className="space-y-2">{projects.map((p) => <li key={p.id} className="flex items-center justify-between text-[13px]"><Link href={`/projects/${p.slug}`} className="hover:underline">{p.name}</Link><span className="text-faint text-[12px]">{p.open} ouvertes{p.overdue ? <span className="text-bad"> · {p.overdue} retard</span> : null}</span></li>)}</ul>
        </Card>
        <Card title="Échéances (90 j)">
          {events.length ? <ul className="space-y-2">{events.slice(0, 6).map((e) => <li key={e.id} className="text-[13px] flex justify-between gap-2"><span>{e.title}</span><span className="text-faint">{fmtDate(e.startsAt)}</span></li>)}</ul> : <Empty>Aucun événement.</Empty>}
          {stale.length > 0 && <p className="text-[12px] text-warn mt-3">{stale.length} partenariat(s) à relancer.</p>}
        </Card>
        <Card title="Agents & automatisations">
          <div className="flex flex-wrap gap-1 mb-3">{agents.map((a) => <Badge key={a.id} tone={statusTone(a.implementation)} title={a.description}>{a.name}</Badge>)}</div>
          <ul className="space-y-1 text-[12px]">{autos.map((a) => <li key={a.id} className="flex justify-between"><span>{a.name}</span><span className="text-faint">{a.enabled ? (a.lastRunAt ? `dernière : ${fmtDate(a.lastRunAt, true)}` : "jamais exécutée") : "désactivée"}</span></li>)}</ul>
        </Card>
        <Card title="Activité réelle récente" className="lg:col-span-2">
          {runs.length ? <ul className="space-y-1.5 text-[13px]">{runs.map((r) => <li key={r.id} className="flex gap-2 items-center"><Badge tone={statusTone(r.status)}>{r.status}</Badge><span className="truncate flex-1">{r.objective}</span><span className="text-faint text-[12px]">{r.mode} · {fmtDate(r.createdAt, true)}</span></li>)}</ul> : <Empty>Aucune exécution pour l&apos;instant.</Empty>}
          {notifs.length > 0 && <div className="mt-3 border-t border-line pt-2 text-[12px] text-muted">Dernières notifications : {notifs.map((n) => n.title).join(" · ")}</div>}
        </Card>
        <Card title="Suggestions d'optimisation">
          {suggestions.length ? <ul className="space-y-2 text-[13px] text-muted">{suggestions.map((s) => <li key={s}>{s}</li>)}</ul> : <Empty>Rien à signaler.</Empty>}
        </Card>
      </div>
    </>
  );
}
