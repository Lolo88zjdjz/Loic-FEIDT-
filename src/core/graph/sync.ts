/**
 * Synchronisation métier → graphe.
 * Chaque service émet un événement de domaine DANS sa transaction ; le
 * gestionnaire correspondant met à jour le graphe dans la même transaction.
 * Garanties : atomicité (même transaction), idempotence (upsert sur
 * ref_table/ref_id et unicité des arêtes), historique (graph_changes),
 * suppressions propagées (nœud retiré + arêtes retirées).
 */
import { eq } from "drizzle-orm";
import { schema, type Tx } from "../db/client";
import { audit } from "../security/audit";
import { findEntityNode, link, retireEntityNode, upsertEntityNode } from "./service";
import type { Sensitivity } from "../shared";

export type DomainEvent =
  | { type: "project.upserted"; id: string }
  | { type: "memory.upserted"; id: string }
  | { type: "memory.removed"; id: string }
  | { type: "organization.upserted"; id: string }
  | { type: "contact.upserted"; id: string }
  | { type: "opportunity.upserted"; id: string }
  | { type: "task.upserted"; id: string }
  | { type: "task.removed"; id: string }
  | { type: "document.upserted"; id: string }
  | { type: "goal.upserted"; id: string }
  | { type: "decision.upserted"; id: string }
  | { type: "event.upserted"; id: string };

export async function emit(tx: Tx, ownerId: string, actor: string, ev: DomainEvent) {
  await handlers[ev.type](tx, ownerId, ev.id, actor);
  await audit(tx, { ownerId, actor, action: ev.type, entityType: ev.type.split(".")[0], entityId: ev.id });
}

async function projectNode(tx: Tx, ownerId: string, projectId: string | null) {
  if (!projectId) return null;
  return findEntityNode(tx, ownerId, "projects", projectId);
}
async function orgNode(tx: Tx, ownerId: string, orgId: string | null) {
  if (!orgId) return null;
  return findEntityNode(tx, ownerId, "organizations", orgId);
}

const handlers: Record<DomainEvent["type"], (tx: Tx, ownerId: string, id: string, actor: string) => Promise<void>> = {
  async "project.upserted"(tx, ownerId, id, actor) {
    const [p] = await tx.select().from(schema.projects).where(eq(schema.projects.id, id));
    await upsertEntityNode(tx, { ownerId, type: "Project", label: p.name, refTable: "projects", refId: p.id, description: p.description,
      properties: { area: p.area, status: p.status, startsOn: p.startsOn, endsOn: p.endsOn }, actor,
      status: p.status === "archived" ? "archived" : "active" });
  },

  async "memory.upserted"(tx, ownerId, id, actor) {
    const [m] = await tx.select().from(schema.memories).where(eq(schema.memories.id, id));
    if (m.status !== "active" && m.status !== "superseded") { await retireEntityNode(tx, ownerId, "memories", id, actor); return; }
    const node = await upsertEntityNode(tx, { status: m.status === "superseded" ? "archived" : "active", ownerId, type: "Memory", label: m.content.length > 70 ? m.content.slice(0, 67) + "…" : m.content,
      refTable: "memories", refId: m.id, description: m.content, sensitivity: m.sensitivity as Sensitivity, sourceId: m.sourceId,
      properties: { memoryType: m.type, category: m.category, observedAt: m.observedAt, confidence: m.confidenceStatus }, actor });
    const pn = await projectNode(tx, ownerId, m.projectId);
    if (pn) await link(tx, { ownerId, type: "BELONGS_TO", source: node.id, target: pn.id, provenance: "Souvenir rattaché au projet (champ project_id)", sensitivity: m.sensitivity as Sensitivity, actor });
    if (m.supersedesId) {
      const old = await findEntityNode(tx, ownerId, "memories", m.supersedesId);
      if (old) await link(tx, { ownerId, type: "SUPERSEDES", source: node.id, target: old.id, provenance: "Nouvelle version d'un souvenir", actor });
    }
  },
  async "memory.removed"(tx, ownerId, id, actor) { await retireEntityNode(tx, ownerId, "memories", id, actor); },

  async "organization.upserted"(tx, ownerId, id, actor) {
    const [o] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, id));
    await upsertEntityNode(tx, { ownerId, type: "Organization", label: o.name, refTable: "organizations", refId: o.id,
      description: o.notes, properties: { kind: o.kind, sector: o.sector, website: o.website }, actor });
  },

  async "contact.upserted"(tx, ownerId, id, actor) {
    const [c] = await tx.select().from(schema.contacts).where(eq(schema.contacts.id, id));
    const node = await upsertEntityNode(tx, { ownerId, type: "Person", label: c.fullName, refTable: "contacts", refId: c.id,
      description: c.notes, properties: { role: c.role, hasEmail: !!c.email }, actor });
    const on = await orgNode(tx, ownerId, c.organizationId);
    if (on) await link(tx, { ownerId, type: "BELONGS_TO", source: node.id, target: on.id, provenance: "Fiche contact CRM : organisation associée", actor });
  },

  async "opportunity.upserted"(tx, ownerId, id, actor) {
    const [o] = await tx.select().from(schema.opportunities).where(eq(schema.opportunities.id, id));
    const node = await upsertEntityNode(tx, { ownerId, type: "Opportunity", label: o.title, refTable: "opportunities", refId: o.id,
      properties: { pipeline: o.pipeline, stage: o.stage, nextAction: o.nextAction }, actor });
    const on = await orgNode(tx, ownerId, o.organizationId);
    if (on) await link(tx, { ownerId, type: "ASSOCIATED_WITH", source: node.id, target: on.id, provenance: `Opportunité CRM (${o.pipeline}) avec cette organisation`, actor });
    const pn = await projectNode(tx, ownerId, o.projectId);
    if (pn) {
      await link(tx, { ownerId, type: "BELONGS_TO", source: node.id, target: pn.id, provenance: "Opportunité suivie dans ce projet", actor });
      if (on) await link(tx, { ownerId, type: "CONNECTED_TO", source: on.id, target: pn.id, provenance: `Organisation en relation avec le projet via l'opportunité « ${o.title} » (statut : ${o.stage})`, actor });
    }
  },

  async "task.upserted"(tx, ownerId, id, actor) {
    const [t] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    if (t.status === "cancelled") { await retireEntityNode(tx, ownerId, "tasks", id, actor); return; }
    const node = await upsertEntityNode(tx, { ownerId, type: "Task", label: t.title, refTable: "tasks", refId: t.id,
      properties: { status: t.status, priority: t.priority, dueAt: t.dueAt }, actor });
    const pn = await projectNode(tx, ownerId, t.projectId);
    if (pn) await link(tx, { ownerId, type: "BELONGS_TO", source: node.id, target: pn.id, provenance: "Tâche du projet", actor });
  },
  async "task.removed"(tx, ownerId, id, actor) { await retireEntityNode(tx, ownerId, "tasks", id, actor); },

  async "document.upserted"(tx, ownerId, id, actor) {
    const [d] = await tx.select().from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.id, id));
    const node = await upsertEntityNode(tx, { ownerId, type: "Document", label: d.title, refTable: "knowledge_documents", refId: d.id,
      description: d.summary, sensitivity: d.sensitivity as Sensitivity, properties: { mime: d.mimeType, status: d.status, version: d.version }, actor });
    const pn = await projectNode(tx, ownerId, d.projectId);
    if (pn) await link(tx, { ownerId, type: "BELONGS_TO", source: node.id, target: pn.id, provenance: "Document importé dans ce projet", actor });
  },

  async "goal.upserted"(tx, ownerId, id, actor) {
    const [g] = await tx.select().from(schema.goals).where(eq(schema.goals.id, id));
    const node = await upsertEntityNode(tx, { ownerId, type: "Goal", label: g.title, refTable: "goals", refId: g.id,
      description: g.description, properties: { horizon: g.horizon, status: g.status, observedAt: g.observedAt }, actor });
    const pn = await projectNode(tx, ownerId, g.projectId);
    if (pn) await link(tx, { ownerId, type: "CONTRIBUTES_TO", source: pn.id, target: node.id, provenance: "Le projet sert cet objectif", actor });
  },

  async "decision.upserted"(tx, ownerId, id, actor) {
    const [d] = await tx.select().from(schema.decisions).where(eq(schema.decisions.id, id));
    const node = await upsertEntityNode(tx, { ownerId, type: "Decision", label: d.problem.slice(0, 70), refTable: "decisions", refId: d.id,
      description: d.decision, properties: { decidedOn: d.decidedOn }, actor });
    const pn = await projectNode(tx, ownerId, d.projectId);
    if (pn) await link(tx, { ownerId, type: "BELONGS_TO", source: node.id, target: pn.id, provenance: "Décision prise dans ce projet", actor });
  },

  async "event.upserted"(tx, ownerId, id, actor) {
    const [e] = await tx.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
    const node = await upsertEntityNode(tx, { ownerId, type: "Event", label: e.title, refTable: "calendar_events", refId: e.id,
      properties: { startsAt: e.startsAt, status: e.status }, actor, status: e.status === "cancelled" ? "archived" : "active" });
    const pn = await projectNode(tx, ownerId, e.projectId);
    if (pn) await link(tx, { ownerId, type: "BELONGS_TO", source: node.id, target: pn.id, provenance: "Événement du projet", actor });
  },
};
