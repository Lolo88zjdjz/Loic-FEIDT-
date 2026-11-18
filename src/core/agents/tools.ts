/**
 * Registre des outils exécutables par les agents. Chaque outil déclare son
 * niveau d'autorisation (1 à 4), un schéma Zod (validation stricte des
 * entrées, y compris venant d'un LLM) et un gestionnaire déterministe.
 */
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { searchMemories, createMemory } from "../memory/service";
import { findPaths, loadGraph, neighborhood, searchNodes } from "../graph/service";
import { searchDocuments } from "../knowledge/service";
import { listProjects, openTasks, createTask, getProjectBySlug, eventsBetween, detectConflicts, listDecisions } from "../projects/service";
import { crmOverview, organizationDossier, staleOpportunities, upsertOrganization, moveOpportunity } from "../crm/service";
import { dayTotals, dayLog, logFood } from "../nutrition/service";
import { canAccess, todayISO, type Sensitivity } from "../shared";

export type ToolContext = { ownerId: string; agentId: string; runId: string; maxSensitivity: Sensitivity; memoryScopes: string[] };
export type ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string; description: string; level: 1 | 2 | 3 | 4; destructive?: boolean; financial?: boolean;
  input: S; run: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>;
  /** Pour niveau ≥ 3 nécessitant validation : résumé lisible de l'action. */
  preview?: (input: z.infer<S>) => string;
};
const tool = <S extends z.ZodTypeAny>(t: ToolDef<S>) => t as unknown as ToolDef;

const scoped = (ctx: ToolContext) => (ctx.memoryScopes.includes("*") ? undefined : ctx.memoryScopes);

export const TOOLS: ToolDef[] = [
  tool({
    name: "memory_search", level: 1, description: "Recherche hybride dans la mémoire persistante (plein texte + similarité). Respecte les catégories et la sensibilité autorisées pour l'agent.",
    input: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(20).default(8) }),
    run: async (ctx, i) => (await searchMemories(ctx.ownerId, i.query, { limit: i.limit, categories: scoped(ctx), maxSensitivity: ctx.maxSensitivity }))
      .map((m) => ({ id: m.id, content: m.content, category: m.category, type: m.type, observedAt: m.observedAt, confidence: m.confidenceStatus, matchedBy: m.matchedBy })),
  }),
  tool({
    name: "memory_create", level: 3, description: "Enregistre un nouveau souvenir (fait, préférence, événement). À n'utiliser que pour une information explicitement fournie ou validée par l'utilisateur.",
    input: z.object({ content: z.string().min(3).max(2000), type: z.enum(["identity", "episodic", "semantic", "procedural", "project", "temporary"]),
      category: z.string().min(2).max(40), sensitivity: z.enum(["public", "personal", "private", "sensitive"]).default("personal"),
      confidenceStatus: z.enum(["user_confirmed", "agent_inferred"]).default("user_confirmed") }),
    preview: (i) => `Enregistrer en mémoire (${i.category}) : « ${i.content} »`,
    run: async (ctx, i) => {
      if (!canAccess(ctx.maxSensitivity, i.sensitivity)) throw new Error("Sensibilité au-delà du plafond de l'agent");
      const m = await createMemory(ctx.ownerId, i, `agent:${ctx.agentId}`);
      return { id: m.id, stored: true };
    },
  }),
  tool({
    name: "graph_search_nodes", level: 1, description: "Recherche des nœuds du graphe de connaissances par nom.",
    input: z.object({ query: z.string().min(1).max(120) }),
    run: async (ctx, i) => (await searchNodes(ctx.ownerId, i.query, 10)).filter((n) => canAccess(ctx.maxSensitivity, n.sensitivity)).map((n) => ({ id: n.id, type: n.type, label: n.label })),
  }),
  tool({
    name: "graph_paths", level: 2, description: "Trouve les chemins relationnels entre deux entités du graphe (par nom) et explique chaque relation. Distingue relations confirmées et inférées.",
    input: z.object({ from: z.string().min(1), to: z.string().min(1), maxHops: z.number().int().min(1).max(5).default(4) }),
    run: async (ctx, i) => {
      const [a] = await searchNodes(ctx.ownerId, i.from, 1); const [b] = await searchNodes(ctx.ownerId, i.to, 1);
      if (!a || !b) return { error: `Nœud introuvable : ${!a ? i.from : i.to}` };
      const g = await loadGraph(ctx.ownerId, { maxSensitivity: ctx.maxSensitivity });
      const paths = findPaths(g.nodes, g.edges, a.id, b.id, i.maxHops, 12);
      return { from: a.label, to: b.label, paths: paths.map((p) => ({ hops: p.edges.length, explanation: p.explanation, containsInferred: p.containsInferred, provenance: p.edges.map((e) => e.provenance) })) };
    },
  }),
  tool({
    name: "graph_neighborhood", level: 1, description: "Liste les entités directement reliées à une entité (voisinage du graphe).",
    input: z.object({ label: z.string().min(1), depth: z.number().int().min(1).max(2).default(1) }),
    run: async (ctx, i) => {
      const [n] = await searchNodes(ctx.ownerId, i.label, 1);
      if (!n) return { error: "Nœud introuvable" };
      const g = await neighborhood(ctx.ownerId, n.id, i.depth, ctx.maxSensitivity);
      const byId = new Map(g.nodes.map((x) => [x.id, x]));
      return { center: n.label, relations: g.edges.map((e) => ({ from: byId.get(e.sourceNodeId)?.label, type: e.type, to: byId.get(e.targetNodeId)?.label, validation: e.validation, provenance: e.provenance })) };
    },
  }),
  tool({
    name: "docs_search", level: 1, description: "Recherche dans les documents importés (Knowledge Vault). Renvoie des extraits avec citation (document, passage, page).",
    input: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(10).default(5) }),
    run: async (ctx, i) => searchDocuments(ctx.ownerId, i.query, { limit: i.limit }),
  }),
  tool({
    name: "projects_overview", level: 1, description: "Vue d'ensemble des projets : statut, tâches ouvertes, tâches en retard.",
    input: z.object({}),
    run: async (ctx) => (await listProjects(ctx.ownerId)).map((p) => ({ slug: p.slug, name: p.name, status: p.status, area: p.area, openTasks: p.open, overdue: p.overdue, endsOn: p.endsOn })),
  }),
  tool({
    name: "tasks_list", level: 1, description: "Liste les tâches ouvertes, éventuellement filtrées par projet (slug).",
    input: z.object({ projectSlug: z.string().optional() }),
    run: async (ctx, i) => {
      const p = i.projectSlug ? await getProjectBySlug(ctx.ownerId, i.projectSlug) : null;
      return (await openTasks(ctx.ownerId, p?.id)).map((r) => ({ id: r.task.id, title: r.task.title, project: r.projectName, priority: r.task.priority, dueAt: r.task.dueAt, status: r.task.status }));
    },
  }),
  tool({
    name: "task_create", level: 3, description: "Crée une tâche interne (aucune conséquence externe).",
    input: z.object({ title: z.string().min(2).max(300), projectSlug: z.string().optional(), dueAt: z.string().optional(), priority: z.number().int().min(1).max(4).default(2) }),
    preview: (i) => `Créer la tâche « ${i.title} »${i.dueAt ? ` (échéance ${i.dueAt})` : ""}`,
    run: async (ctx, i) => {
      const p = i.projectSlug ? await getProjectBySlug(ctx.ownerId, i.projectSlug) : null;
      const t = await createTask(ctx.ownerId, { title: i.title, projectId: p?.id ?? null, dueAt: i.dueAt ? new Date(i.dueAt) : null, priority: i.priority }, `agent:${ctx.agentId}`);
      return { id: t.id, created: true, project: p?.name ?? null };
    },
  }),
  tool({
    name: "crm_overview", level: 1, description: "Pipeline CRM : organisations, opportunités (partenariats / candidatures) et leurs statuts.",
    input: z.object({ pipeline: z.enum(["partnership", "application"]).optional() }),
    run: async (ctx, i) => {
      const o = await crmOverview(ctx.ownerId);
      const orgName = new Map(o.orgs.map((x) => [x.id, x.name]));
      return o.opps.filter((x) => !i.pipeline || x.pipeline === i.pipeline).map((x) => ({ id: x.id, title: x.title, organization: orgName.get(x.organizationId ?? ""), pipeline: x.pipeline, stage: x.stage, nextAction: x.nextAction, lastInteractionAt: x.lastInteractionAt }));
    },
  }),
  tool({
    name: "crm_org_dossier", level: 1, description: "Dossier complet d'une organisation : contacts, opportunités, historique des échanges et des statuts.",
    input: z.object({ name: z.string().min(1) }),
    run: async (ctx, i) => (await organizationDossier(ctx.ownerId, i.name)) ?? { error: "Organisation introuvable dans le CRM" },
  }),
  tool({
    name: "crm_stale", level: 2, description: "Partenariats en cours sans interaction depuis N jours (candidats à relance).",
    input: z.object({ days: z.number().int().min(1).max(120).default(10) }),
    run: async (ctx, i) => (await staleOpportunities(ctx.ownerId, i.days)).map((o) => ({ id: o.id, title: o.title, organization: o.org_name, stage: o.stage, lastInteractionAt: o.lastInteractionAt })),
  }),
  tool({
    name: "crm_add_organization", level: 3, description: "Ajoute (ou met à jour) une organisation dans le CRM.",
    input: z.object({ name: z.string().min(1).max(120), kind: z.enum(["brand", "employer", "school", "association", "company"]).default("company"), sector: z.string().max(80).optional(), notes: z.string().max(2000).optional() }),
    preview: (i) => `Ajouter « ${i.name} » au CRM`,
    run: async (ctx, i) => { const r = await upsertOrganization(ctx.ownerId, i, `agent:${ctx.agentId}`); return { id: r.org.id, created: r.created }; },
  }),
  tool({
    name: "crm_move_opportunity", level: 3, description: "Change l'étape d'une opportunité du CRM.",
    input: z.object({ opportunityId: z.string().uuid(), stage: z.string(), note: z.string().max(500).optional() }),
    preview: (i) => `Passer l'opportunité ${i.opportunityId.slice(0, 8)} à l'étape « ${i.stage} »`,
    run: async (ctx, i) => { const o = await moveOpportunity(ctx.ownerId, i.opportunityId, i.stage, i.note ?? null, `agent:${ctx.agentId}`); return { id: o.id, stage: o.stage }; },
  }),
  tool({
    name: "calendar_upcoming", level: 1, description: "Événements des N prochains jours et conflits horaires détectés.",
    input: z.object({ days: z.number().int().min(1).max(120).default(14) }),
    run: async (ctx, i) => {
      const ev = await eventsBetween(ctx.ownerId, new Date(), new Date(Date.now() + i.days * 86400_000));
      return { events: ev.map((e) => ({ title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, status: e.status, location: e.location })), conflicts: detectConflicts(ev) };
    },
  }),
  tool({
    name: "nutrition_log", level: 3, description: "Ajoute un aliment au journal (calcul déterministe à partir de la base d'aliments).",
    input: z.object({ food: z.string().min(1).max(100), grams: z.number().positive().max(5000), date: z.string().optional(), meal: z.string().max(40).optional() }),
    preview: (i) => `Ajouter ${i.grams} g de ${i.food} au journal`,
    run: async (ctx, i) => logFood(ctx.ownerId, { foodQuery: i.food, grams: i.grams, eatenOn: i.date, meal: i.meal ?? null }, `agent:${ctx.agentId}`),
  }),
  tool({
    name: "nutrition_day", level: 1, description: "Totaux nutritionnels d'une journée (kcal, protéines, glucides, lipides) et détail.",
    input: z.object({ date: z.string().optional() }),
    run: async (ctx, i) => { const d = i.date ?? todayISO(); return { totals: await dayTotals(ctx.ownerId, d), entries: await dayLog(ctx.ownerId, d) }; },
  }),
  tool({
    name: "decisions_list", level: 1, description: "Historique des décisions enregistrées.",
    input: z.object({}),
    run: async (ctx) => listDecisions(ctx.ownerId),
  }),
  tool({
    name: "costs_report", level: 2, description: "Consommation IA mesurée sur N jours : par agent, par modèle, tokens, coûts, échecs.",
    input: z.object({ days: z.number().int().min(1).max(90).default(30) }),
    run: async (ctx, i) => costsReport(ctx.ownerId, i.days),
  }),
  tool({
    name: "plugins_audit", level: 1, description: "Inventaire vérifié des outils, dépendances et intégrations (statut, version, risques).",
    input: z.object({}),
    run: async () => (await db.select().from(schema.pluginDefinitions)).map((p) => ({ name: p.name, kind: p.kind, status: p.status, installed: p.installedVersion, latest: p.latestVersion, function: p.function, risks: p.risks, verifiedAt: p.verifiedAt })),
  }),
  tool({
    name: "draft_email", level: 3, description: "Prépare un brouillon d'e-mail et le place en attente de validation. N'envoie RIEN. Ne jamais inventer une adresse : laisser `to` vide si inconnue.",
    input: z.object({ to: z.string().max(200).default(""), subject: z.string().min(2).max(200), body: z.string().min(10).max(8000), organization: z.string().max(120).optional() }),
    run: async (ctx, i) => {
      const [a] = await db.insert(schema.approvalRequests).values({
        ownerId: ctx.ownerId, runId: ctx.runId, agentId: ctx.agentId, toolName: "email_send", permissionLevel: 4,
        actionSummary: `Envoyer l'e-mail « ${i.subject} »${i.to ? ` à ${i.to}` : " (destinataire à compléter)"}`,
        preview: `À : ${i.to || "(à compléter)"}\nObjet : ${i.subject}\n\n${i.body}`, payload: i,
        idempotencyKey: `draft:${ctx.runId}:${i.subject}`.slice(0, 200), expiresAt: new Date(Date.now() + 14 * 86400_000),
      }).onConflictDoNothing().returning();
      return { draftId: a?.id ?? null, status: "waiting_approval", note: "Brouillon enregistré. Aucun envoi sans votre validation ; Gmail n'est pas connecté." };
    },
  }),
  tool({
    name: "email_send", level: 4, description: "Envoie un e-mail via l'intégration Gmail. Exige une approbation explicite.",
    input: z.object({ to: z.string().max(200), subject: z.string().min(2), body: z.string().min(1), organization: z.string().optional() }),
    preview: (i) => `Envoyer l'e-mail « ${i.subject} » à ${i.to}`,
    run: async (ctx) => {
      const [conn] = await db.select().from(schema.integrationConnections).where(and(eq(schema.integrationConnections.ownerId, ctx.ownerId), eq(schema.integrationConnections.provider, "gmail")));
      if (conn?.status !== "connected") return { sent: false, blocked: "Gmail non connecté : envoi impossible. Le brouillon reste disponible." };
      return { sent: false, blocked: "Connecteur Gmail non implémenté dans cette version." };
    },
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export async function costsReport(ownerId: string, days: number) {
  const since = new Date(Date.now() - days * 86400_000);
  const rows = await db.select().from(schema.modelUsage).where(and(eq(schema.modelUsage.ownerId, ownerId), gte(schema.modelUsage.createdAt, since))).orderBy(desc(schema.modelUsage.createdAt));
  const group = (key: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; failures: number }>();
    for (const r of rows) {
      const g = m.get(key(r)) ?? { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, failures: 0 };
      g.calls++; g.costUsd += Number(r.costUsd); g.inputTokens += r.inputTokens; g.outputTokens += r.outputTokens; g.cacheReadTokens += r.cacheReadTokens; if (!r.success) g.failures++;
      m.set(key(r), g);
    }
    return Object.fromEntries(m);
  };
  const runs = await db.execute(sql`SELECT mode, status, count(*)::int AS n, coalesce(sum(cost_usd),0)::float AS cost FROM agent_runs WHERE owner_id = ${ownerId} AND created_at >= ${since} AND parent_run_id IS NULL GROUP BY mode, status`);
  const r = runs.rows as { mode: string; status: string; n: number; cost: number }[];
  const completed = r.filter((x) => x.status === "completed");
  const totalCost = rows.reduce((s, x) => s + Number(x.costUsd), 0);
  const completedCount = completed.reduce((s, x) => s + x.n, 0);
  return {
    periodDays: days, apiCalls: rows.length, totalCostUsd: Math.round(totalCost * 1e6) / 1e6,
    byAgent: group((x) => x.agentId), byModel: group((x) => x.modelId), byWorkflow: group((x) => x.workflow ?? "chat"),
    missions: r, avgCostPerCompletedMissionUsd: completedCount ? Math.round((totalCost / completedCount) * 1e6) / 1e6 : null,
    partialCostRows: rows.filter((x) => x.costStatus === "partial").length,
  };
}
