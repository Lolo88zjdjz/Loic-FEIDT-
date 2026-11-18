import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createProject, listProjects, openTasks, createTask, setTaskStatus } from "@/core/projects/service";
import { Badge, Card, fmtDate, PageHeader } from "@/components/ui";

async function addProject(f: FormData) {
  "use server"; const u = await requireUser();
  await createProject(u.id, { name: String(f.get("name")), area: String(f.get("area")) as "other", description: (f.get("description") as string) || null });
  revalidatePath("/projects");
}
async function addTask(f: FormData) {
  "use server"; const u = await requireUser();
  await createTask(u.id, { title: String(f.get("title")), projectId: (f.get("projectId") as string) || null, priority: Number(f.get("priority") ?? 2), dueAt: f.get("dueAt") ? new Date(String(f.get("dueAt"))) : null });
  revalidatePath("/projects");
}
async function setStatus(f: FormData) { "use server"; const u = await requireUser(); await setTaskStatus(u.id, String(f.get("id")), String(f.get("status")) as "done"); revalidatePath("/projects"); }

export default async function ProjectsPage() {
  const user = await requireUser();
  const [projects, tasks] = await Promise.all([listProjects(user.id), openTasks(user.id)]);
  return (
    <>
      <PageHeader title="Projects" subtitle="Projets, tâches et échéances. Chaque projet est un nœud du graphe." />
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
        {projects.map((p) => (
          <Link key={p.id} href={`/projects/${p.slug}`} className="card p-4 hover:border-faint" data-testid="project-card">
            <div className="flex items-center justify-between"><span className="font-semibold">{p.name}</span><Badge>{p.area}</Badge></div>
            <p className="text-[12px] text-muted mt-1 line-clamp-2">{p.description}</p>
            <div className="text-[12px] text-faint mt-2">{p.open} ouvertes · {p.done} faites{p.overdue ? <span className="text-bad"> · {p.overdue} en retard</span> : null}</div>
          </Link>
        ))}
      </div>
      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <Card title={`Tâches ouvertes (${tasks.length})`}>
          <table className="w-full text-[13px]"><tbody>{tasks.map(({ task: t, projectName }) => (
            <tr key={t.id} className="border-t border-line" data-testid="task-row"><td className="py-1.5 w-8"><form action={setStatus}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="done" /><button className="size-4 rounded border border-line hover:border-ok" title="Terminer" /></form></td>
              <td>{t.title}{t.createdBy !== "user" && <span className="text-faint text-[11px]"> · {t.createdBy}</span>}</td><td className="text-faint text-[12px]">{projectName ?? "—"}</td>
              <td><Badge tone={t.priority === 1 ? "bad" : t.priority === 2 ? "warn" : "neutral"}>P{t.priority}</Badge></td>
              <td className={`text-[12px] ${t.dueAt && t.dueAt < new Date() ? "text-bad" : "text-faint"}`}>{t.dueAt ? fmtDate(t.dueAt) : ""}</td>
              <td><form action={setStatus}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="cancelled" /><button className="text-faint text-[11px] hover:text-bad">annuler</button></form></td></tr>))}</tbody></table>
        </Card>
        <div className="space-y-4">
          <Card title="Nouvelle tâche">
            <form action={addTask} className="space-y-2">
              <input name="title" className="input" placeholder="Titre" required data-testid="task-title" />
              <select name="projectId" className="input"><option value="">Sans projet</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <div className="flex gap-2"><select name="priority" defaultValue="2" className="input"><option value="1">P1 urgent</option><option value="2">P2</option><option value="3">P3</option><option value="4">P4</option></select><input type="date" name="dueAt" className="input" /></div>
              <button className="btn btn-primary" data-testid="task-save">Créer</button>
            </form>
          </Card>
          <Card title="Nouveau projet">
            <form action={addProject} className="space-y-2">
              <input name="name" className="input" placeholder="Nom" required />
              <select name="area" className="input">{["career", "partnerships", "academic", "sport", "nutrition", "travel", "growth", "other"].map((a) => <option key={a}>{a}</option>)}</select>
              <textarea name="description" className="input" rows={2} placeholder="Description" />
              <button className="btn">Créer le projet</button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
