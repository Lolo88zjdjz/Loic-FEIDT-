import { and, asc, desc, eq, inArray, lt, sql, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client";
import { emit } from "../graph/sync";
import { AppError, slugify } from "../shared";

export async function listProjects(ownerId: string) {
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.ownerId, ownerId)).orderBy(asc(schema.projects.createdAt));
  const counts = await db.execute(sql`SELECT project_id, count(*) FILTER (WHERE status IN ('todo','doing'))::int AS open,
      count(*) FILTER (WHERE status IN ('todo','doing') AND due_at < now())::int AS overdue,
      count(*) FILTER (WHERE status = 'done')::int AS done
    FROM tasks WHERE owner_id = ${ownerId} GROUP BY project_id`);
  const byP = new Map((counts.rows as { project_id: string; open: number; overdue: number; done: number }[]).map((r) => [r.project_id, r]));
  return projects.map((p) => ({ ...p, open: byP.get(p.id)?.open ?? 0, overdue: byP.get(p.id)?.overdue ?? 0, done: byP.get(p.id)?.done ?? 0 }));
}

export async function getProjectBySlug(ownerId: string, slug: string) {
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.ownerId, ownerId), eq(schema.projects.slug, slug)));
  return p ?? null;
}

export const projectInput = z.object({
  name: z.string().trim().min(2).max(120), description: z.string().max(2000).nullable().optional(),
  area: z.enum(["career", "partnerships", "academic", "sport", "nutrition", "travel", "growth", "other"]),
  startsOn: z.string().date().nullable().optional(), endsOn: z.string().date().nullable().optional(),
});
export async function createProject(ownerId: string, input: z.input<typeof projectInput>, actor = "user") {
  const v = projectInput.parse(input);
  return db.transaction(async (tx) => {
    const [p] = await tx.insert(schema.projects).values({ ...v, ownerId, slug: slugify(v.name) }).onConflictDoNothing().returning();
    if (!p) throw new AppError("Un projet porte déjà ce nom");
    await emit(tx, ownerId, actor, { type: "project.upserted", id: p.id });
    return p;
  });
}

export const taskInput = z.object({
  title: z.string().trim().min(2).max(300), description: z.string().max(4000).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(), priority: z.coerce.number().int().min(1).max(4).default(2),
  dueAt: z.coerce.date().nullable().optional(),
});
export async function createTask(ownerId: string, input: z.input<typeof taskInput>, actor = "user") {
  const v = taskInput.parse(input);
  return db.transaction(async (tx) => {
    const [t] = await tx.insert(schema.tasks).values({ ...v, ownerId, createdBy: actor }).returning();
    await emit(tx, ownerId, actor, { type: "task.upserted", id: t.id });
    return t;
  });
}
export async function setTaskStatus(ownerId: string, id: string, status: "todo" | "doing" | "done" | "cancelled", actor = "user") {
  return db.transaction(async (tx) => {
    const [t] = await tx.update(schema.tasks).set({ status, completedAt: status === "done" ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(schema.tasks.ownerId, ownerId), eq(schema.tasks.id, id))).returning();
    if (!t) throw new AppError("Tâche introuvable", "not_found", 404);
    await emit(tx, ownerId, actor, { type: status === "cancelled" ? "task.removed" : "task.upserted", id });
    return t;
  });
}

export async function openTasks(ownerId: string, projectId?: string) {
  return db.select({ task: schema.tasks, projectName: schema.projects.name, projectSlug: schema.projects.slug })
    .from(schema.tasks).leftJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .where(and(eq(schema.tasks.ownerId, ownerId), inArray(schema.tasks.status, ["todo", "doing"]), projectId ? eq(schema.tasks.projectId, projectId) : undefined))
    .orderBy(sql`${schema.tasks.dueAt} ASC NULLS LAST`, asc(schema.tasks.priority));
}

export async function overdueTasks(ownerId: string) {
  return db.select().from(schema.tasks).where(and(eq(schema.tasks.ownerId, ownerId), inArray(schema.tasks.status, ["todo", "doing"]), lt(schema.tasks.dueAt, new Date())));
}

export const eventInput = z.object({
  title: z.string().trim().min(2).max(200), startsAt: z.coerce.date(), endsAt: z.coerce.date().nullable().optional(),
  allDay: z.coerce.boolean().default(false), location: z.string().max(200).nullable().optional(),
  status: z.enum(["planned", "tentative", "confirmed", "cancelled"]).default("planned"),
  projectId: z.string().uuid().nullable().optional(), notes: z.string().max(2000).nullable().optional(),
});
export async function createEvent(ownerId: string, input: z.input<typeof eventInput>, actor = "user") {
  const v = eventInput.parse(input);
  return db.transaction(async (tx) => {
    const [e] = await tx.insert(schema.calendarEvents).values({ ...v, ownerId }).returning();
    await emit(tx, ownerId, actor, { type: "event.upserted", id: e.id });
    return e;
  });
}
export async function eventsBetween(ownerId: string, from: Date, to: Date) {
  return db.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.ownerId, ownerId),
    lte(schema.calendarEvents.startsAt, to), gte(sql`coalesce(${schema.calendarEvents.endsAt}, ${schema.calendarEvents.startsAt})`, from)))
    .orderBy(asc(schema.calendarEvents.startsAt));
}
/** Détection déterministe des conflits horaires (événements non « journée entière » qui se chevauchent). */
export function detectConflicts(events: (typeof schema.calendarEvents.$inferSelect)[]) {
  const timed = events.filter((e) => !e.allDay && e.status !== "cancelled" && e.endsAt);
  const out: [string, string][] = [];
  for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
    const a = timed[i], b = timed[j];
    if (a.startsAt < b.endsAt! && b.startsAt < a.endsAt!) out.push([a.title, b.title]);
  }
  return out;
}

export async function listDecisions(ownerId: string) {
  return db.select().from(schema.decisions).where(eq(schema.decisions.ownerId, ownerId)).orderBy(desc(schema.decisions.createdAt));
}
export const decisionInput = z.object({
  problem: z.string().trim().min(3), options: z.array(z.string()).default([]), arguments: z.string().nullable().optional(),
  constraints: z.string().nullable().optional(), decision: z.string().nullable().optional(), decidedOn: z.string().date().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
});
export async function createDecision(ownerId: string, input: z.input<typeof decisionInput>, actor = "user") {
  const v = decisionInput.parse(input);
  return db.transaction(async (tx) => {
    const [d] = await tx.insert(schema.decisions).values({ ...v, ownerId }).returning();
    await emit(tx, ownerId, actor, { type: "decision.upserted", id: d.id });
    return d;
  });
}
