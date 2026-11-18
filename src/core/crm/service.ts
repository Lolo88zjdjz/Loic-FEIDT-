import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client";
import { emit } from "../graph/sync";
import { APPLICATION_STAGES, PARTNERSHIP_STAGES, AppError } from "../shared";

export const orgInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["brand", "employer", "school", "association", "company"]).default("company"),
  sector: z.string().trim().max(80).nullable().optional(),
  website: z.string().trim().url().nullable().optional().or(z.literal("").transform(() => null)),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export async function upsertOrganization(ownerId: string, input: z.input<typeof orgInput>, actor = "user") {
  const v = orgInput.parse(input);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(schema.organizations).where(and(eq(schema.organizations.ownerId, ownerId), sql`lower(${schema.organizations.name}) = lower(${v.name})`));
    const [org] = existing
      ? await tx.update(schema.organizations).set({ ...v, notes: v.notes ?? existing.notes, sector: v.sector ?? existing.sector, updatedAt: new Date() }).where(eq(schema.organizations.id, existing.id)).returning()
      : await tx.insert(schema.organizations).values({ ...v, ownerId }).returning();
    await emit(tx, ownerId, actor, { type: "organization.upserted", id: org.id });
    return { org, created: !existing };
  });
}

export const contactInput = z.object({
  fullName: z.string().trim().min(2).max(120), organizationId: z.string().uuid().nullable().optional(),
  role: z.string().trim().max(120).nullable().optional(), email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(), linkedin: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});
export async function createContact(ownerId: string, input: z.input<typeof contactInput>, actor = "user") {
  const v = contactInput.parse(input);
  return db.transaction(async (tx) => {
    const [c] = await tx.insert(schema.contacts).values({ ...v, ownerId }).returning();
    await emit(tx, ownerId, actor, { type: "contact.upserted", id: c.id });
    return c;
  });
}

export const opportunityInput = z.object({
  organizationId: z.string().uuid().nullable().optional(), projectId: z.string().uuid().nullable().optional(),
  pipeline: z.enum(["partnership", "application"]), title: z.string().trim().min(2).max(200), stage: z.string(),
  valueNote: z.string().max(2000).nullable().optional(), nextAction: z.string().max(500).nullable().optional(),
  nextActionAt: z.coerce.date().nullable().optional(), lastInteractionAt: z.coerce.date().nullable().optional(),
}).refine((o) => (o.pipeline === "partnership" ? (PARTNERSHIP_STAGES as readonly string[]) : (APPLICATION_STAGES as readonly string[])).includes(o.stage), { message: "Étape invalide pour ce pipeline" });

export async function createOpportunity(ownerId: string, input: z.input<typeof opportunityInput>, actor = "user") {
  const v = opportunityInput.parse(input);
  return db.transaction(async (tx) => {
    const [o] = await tx.insert(schema.opportunities).values({ ...v, ownerId }).returning();
    await tx.insert(schema.opportunityStageHistory).values({ opportunityId: o.id, fromStage: null, toStage: o.stage, changedBy: actor });
    await emit(tx, ownerId, actor, { type: "opportunity.upserted", id: o.id });
    return o;
  });
}

export async function moveOpportunity(ownerId: string, id: string, stage: string, note: string | null, actor = "user") {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(schema.opportunities).where(and(eq(schema.opportunities.ownerId, ownerId), eq(schema.opportunities.id, id)));
    if (!o) throw new AppError("Opportunité introuvable", "not_found", 404);
    const allowed = (o.pipeline === "partnership" ? PARTNERSHIP_STAGES : APPLICATION_STAGES) as readonly string[];
    if (!allowed.includes(stage)) throw new AppError("Étape invalide");
    if (o.stage === stage) return o;
    const [u] = await tx.update(schema.opportunities).set({ stage, updatedAt: new Date() }).where(eq(schema.opportunities.id, id)).returning();
    await tx.insert(schema.opportunityStageHistory).values({ opportunityId: id, fromStage: o.stage, toStage: stage, note, changedBy: actor });
    await emit(tx, ownerId, actor, { type: "opportunity.upserted", id });
    return u;
  });
}

export const interactionInput = z.object({
  organizationId: z.string().uuid(), contactId: z.string().uuid().nullable().optional(), opportunityId: z.string().uuid().nullable().optional(),
  channel: z.enum(["email", "phone", "meeting", "linkedin", "note"]), direction: z.enum(["inbound", "outbound", "internal"]).nullable().optional(),
  summary: z.string().trim().min(3).max(4000), occurredOn: z.string().date().nullable().optional(),
  datePrecision: z.enum(["day", "month", "unknown"]).default("day"),
});
export async function logInteraction(ownerId: string, input: z.input<typeof interactionInput>, actor = "user") {
  const v = interactionInput.parse(input);
  return db.transaction(async (tx) => {
    const [i] = await tx.insert(schema.interactions).values({ ...v, ownerId }).returning();
    if (v.opportunityId && v.occurredOn && v.datePrecision === "day")
      await tx.update(schema.opportunities).set({ lastInteractionAt: new Date(v.occurredOn), updatedAt: new Date() }).where(eq(schema.opportunities.id, v.opportunityId));
    await emit(tx, ownerId, actor, { type: "organization.upserted", id: v.organizationId });
    return i;
  });
}

export async function crmOverview(ownerId: string) {
  const orgs = await db.select().from(schema.organizations).where(eq(schema.organizations.ownerId, ownerId)).orderBy(asc(schema.organizations.name));
  const opps = await db.select().from(schema.opportunities).where(eq(schema.opportunities.ownerId, ownerId)).orderBy(desc(schema.opportunities.updatedAt));
  const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.ownerId, ownerId));
  const inter = await db.select().from(schema.interactions).where(eq(schema.interactions.ownerId, ownerId)).orderBy(desc(schema.interactions.occurredOn));
  return { orgs, opps, contacts, interactions: inter };
}

export async function organizationDossier(ownerId: string, nameOrId: string) {
  const [org] = await db.select().from(schema.organizations).where(and(eq(schema.organizations.ownerId, ownerId),
    sql`(${schema.organizations.id}::text = ${nameOrId} OR lower(${schema.organizations.name}) = lower(${nameOrId}) OR ${schema.organizations.name} ILIKE ${"%" + nameOrId + "%"})`)).limit(1);
  if (!org) return null;
  const [contacts, opps, inter] = await Promise.all([
    db.select().from(schema.contacts).where(eq(schema.contacts.organizationId, org.id)),
    db.select().from(schema.opportunities).where(eq(schema.opportunities.organizationId, org.id)),
    db.select().from(schema.interactions).where(eq(schema.interactions.organizationId, org.id)).orderBy(desc(schema.interactions.occurredOn)),
  ]);
  const history = opps.length ? await db.select().from(schema.opportunityStageHistory).where(inArray(schema.opportunityStageHistory.opportunityId, opps.map((o) => o.id))).orderBy(asc(schema.opportunityStageHistory.changedAt)) : [];
  return { org, contacts, opportunities: opps, interactions: inter, stageHistory: history };
}

/** Discussions sans nouvelle depuis N jours (partenariats en cours). */
export async function staleOpportunities(ownerId: string, days = 10) {
  const rows = await db.select({ o: schema.opportunities, orgName: schema.organizations.name }).from(schema.opportunities)
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.opportunities.organizationId))
    .where(and(eq(schema.opportunities.ownerId, ownerId), eq(schema.opportunities.pipeline, "partnership"),
      sql`${schema.opportunities.stage} IN ('contacted','replied','negotiating')`,
      sql`coalesce(${schema.opportunities.lastInteractionAt}, ${schema.opportunities.updatedAt}) < now() - make_interval(days => ${days})`))
    .orderBy(sql`coalesce(${schema.opportunities.lastInteractionAt}, ${schema.opportunities.updatedAt}) ASC`);
  return rows.map((r) => ({ ...r.o, org_name: r.orgName ?? "—" }));
}
