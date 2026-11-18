import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { createEvent, detectConflicts, eventsBetween, openTasks } from "@/core/projects/service";
import { Badge, Card, Empty, PageHeader, statusTone } from "@/components/ui";

async function add(f: FormData) {
  "use server"; const u = await requireUser();
  const allDay = f.get("allDay") === "on"; const date = String(f.get("date")); const start = String(f.get("start") || "09:00"); const end = String(f.get("end") || "");
  await createEvent(u.id, { title: String(f.get("title")), startsAt: new Date(`${date}T${allDay ? "00:00" : start}`), endsAt: end && !allDay ? new Date(`${date}T${end}`) : null, allDay,
    location: (f.get("location") as string) || null, status: String(f.get("status")) as "planned", projectId: (f.get("projectId") as string) || null });
  revalidatePath("/calendar");
}

export default async function CalendarPage() {
  const user = await requireUser();
  const from = new Date(); from.setDate(from.getDate() - 7);
  const events = await eventsBetween(user.id, from, new Date(Date.now() + 180 * 86400_000));
  const tasks = (await openTasks(user.id)).filter((t) => t.task.dueAt);
  const conflicts = detectConflicts(events);
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.ownerId, user.id));
  const items = [...events.map((e) => ({ kind: "event" as const, date: e.startsAt, title: e.title, status: e.status, extra: e.location })), ...tasks.map((t) => ({ kind: "task" as const, date: t.task.dueAt!, title: t.task.title, status: "échéance", extra: t.projectName }))]
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const byMonth = new Map<string, typeof items>();
  for (const i of items) { const k = i.date.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }); byMonth.set(k, [...(byMonth.get(k) ?? []), i]); }
  return (
    <>
      <PageHeader title="Calendar" subtitle="Calendrier local LOÏC OS (événements + échéances de tâches). Google Calendar : non connecté (voir Settings → Intégrations)." />
      {conflicts.length > 0 && <div className="card p-3 mb-4 text-warn text-[13px]">⚠️ Conflits horaires : {conflicts.map(([a, b]) => `${a} ↔ ${b}`).join(" ; ")}</div>}
      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-4">
          {items.length === 0 && <Empty>Rien de planifié.</Empty>}
          {[...byMonth].map(([month, list]) => (
            <Card key={month} title={month}><ul className="space-y-1.5 text-[13px]">{list.map((i, j) => (
              <li key={j} className="flex gap-3 items-center"><span className="w-20 text-faint text-[12px]">{i.date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })}</span>
                <Badge tone={i.kind === "task" ? "info" : statusTone(i.status)}>{i.kind === "task" ? "tâche" : i.status}</Badge><span>{i.title}</span>{i.extra && <span className="text-faint text-[12px]">· {i.extra}</span>}</li>))}</ul></Card>
          ))}
        </div>
        <Card title="Nouvel événement"><form action={add} className="space-y-2">
          <input name="title" className="input" placeholder="Titre (ex. Partiel finance)" required />
          <input type="date" name="date" className="input" required />
          <div className="flex gap-2"><input type="time" name="start" className="input" /><input type="time" name="end" className="input" /></div>
          <label className="text-[12px] flex gap-2 items-center"><input type="checkbox" name="allDay" /> Journée entière</label>
          <input name="location" className="input" placeholder="Lieu" />
          <select name="status" className="input"><option value="planned">Prévu</option><option value="tentative">Provisoire</option><option value="confirmed">Confirmé</option></select>
          <select name="projectId" className="input"><option value="">Sans projet</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button className="btn btn-primary">Ajouter</button></form></Card>
      </div>
    </>
  );
}
