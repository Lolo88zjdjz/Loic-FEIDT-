/**
 * Automatisations persistantes. Planification : pg-boss (worker/index.ts).
 * Chaque exécution est tracée (automation_runs + agent_runs) et produit une
 * notification. Aucune automatisation n'envoie quoi que ce soit à l'extérieur.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { runDeterministic } from "../orchestration/deterministic";
import { startRun, finishRun, addStep } from "../orchestration/engine";
import { llmAvailable, runAgentLLM } from "../orchestration/llm";
import { staleOpportunities } from "../crm/service";
import { expireMemories, findContradictionCandidates } from "../memory/service";
import { budgetState } from "../model-router/router";
import { integrityReport } from "../graph/service";
import { runPluginAudit } from "../plugins/audit";

export const AUTOMATION_SEEDS = [
  { key: "daily_briefing", name: "Briefing quotidien", cron: "30 7 * * *", requiresLlm: false, description: "Événements, tâches, échéances, projets et priorités du jour (assemblé depuis vos données)." },
  { key: "internship_watch", name: "Veille stages", cron: "0 9 * * 1,4", requiresLlm: true, description: "Recherche d'offres (web), comparaison aux critères, déduplication, enregistrement et notification. Nécessite ANTHROPIC_API_KEY." },
  { key: "partnership_followup", name: "Suivi partenariats", cron: "0 18 * * 1-5", requiresLlm: false, description: "Repère les discussions sans réponse et propose des relances (brouillons uniquement, aucun envoi)." },
  { key: "revision_plan", name: "Révisions", cron: "0 19 * * 0", requiresLlm: false, description: "Examens à venir, cours prioritaires, planning proposé. La génération d'exercices nécessite une clé API." },
  { key: "weekly_review", name: "Weekly Review", cron: "0 20 * * 0", requiresLlm: false, description: "Réalisations, retards, priorités et échéances de la semaine." },
  { key: "system_health", name: "Santé du système", cron: "0 3 * * *", requiresLlm: false, description: "Workflows en erreur, coûts vs budgets, intégrations, extensions obsolètes, intégrité du graphe, expiration des souvenirs." },
] as const;

type AutomationRow = typeof schema.automations.$inferSelect;
type Handler = (a: AutomationRow) => Promise<{ title: string; body: string; output: Record<string, unknown>; skipped?: string }>;

const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }) : "");

const handlers: Record<string, Handler> = {
  async daily_briefing(a) {
    const run = await startRun({ ownerId: a.ownerId, agentId: "atlas", objective: "Briefing quotidien", mode: "deterministic", workflow: "daily_briefing" });
    const r = await runDeterministic(a.ownerId, run.id, "atlas", { kind: "overview" });
    await finishRun(run.id, "completed", { reply: r.reply });
    return { title: `Briefing du ${fmt(new Date())}`, body: r.reply, output: { runId: run.id } };
  },
  async internship_watch(a) {
    if (!llmAvailable()) return { title: "Veille stages non exécutée", body: "Bloquée : la recherche d'offres réelles nécessite ANTHROPIC_API_KEY (outil web_search). Aucune offre n'est inventée.", output: {}, skipped: "no_api_key" };
    const r = await runAgentLLM({ ownerId: a.ownerId, agentId: "nexus", objective: "Recherche sur le web des offres de stage récentes (4 à 5 mois, début printemps 2027, Paris en priorité) en sales, wholesale, business development, e-commerce, retail ou partenariats, idéalement dans le sport, l'outdoor, le luxe ou les marques premium. Pour chaque offre : entreprise, intitulé, lieu, dates, URL, date de publication. Ne liste que des offres trouvées.", profile: { complexity: "medium", risk: "low", needsWeb: true } });
    return { title: "Veille stages", body: r.reply, output: { runId: r.runId, status: r.status } };
  },
  async partnership_followup(a) {
    const days = Number((a.config as { days?: number }).days ?? 10);
    const stale = await staleOpportunities(a.ownerId, days);
    const body = stale.length
      ? [`${stale.length} discussion(s) sans échange depuis plus de ${days} jours :`, ...stale.map((o) => `- ${o.org_name} — ${o.title} (${o.stage})`), "", "Demandez « Prépare une relance pour <marque> » dans le Command Center : un brouillon sera créé, rien ne sera envoyé."].join("\n")
      : "Aucune discussion en attente de relance.";
    return { title: "Suivi partenariats", body, output: { stale: stale.map((s) => s.id) } };
  },
  async revision_plan(a) {
    const exams = await db.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.ownerId, a.ownerId), gte(schema.calendarEvents.startsAt, new Date()), sql`${schema.calendarEvents.title} ~* '(examen|partiel|exam|quiz|oral)'`)).orderBy(schema.calendarEvents.startsAt).limit(10);
    const docs = await db.select({ title: schema.knowledgeDocuments.title, cls: schema.knowledgeDocuments.classification }).from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.ownerId, a.ownerId));
    const body = exams.length
      ? ["Examens à venir :", ...exams.map((e) => { const d = Math.ceil((e.startsAt.getTime() - Date.now()) / 86400_000); return `- ${fmt(e.startsAt)} — ${e.title} (J-${d}) : ${d <= 7 ? "révision intensive" : d <= 21 ? "2 séances/semaine" : "1 séance/semaine"}`; }),
        "", docs.length ? `${docs.length} document(s) de cours disponibles dans le Vault.` : "Aucun cours importé : importez vos supports dans le Knowledge Vault.",
        llmAvailable() ? "" : "Génération d'exercices : nécessite ANTHROPIC_API_KEY."].filter(Boolean).join("\n")
      : "Aucun examen enregistré dans le calendrier. Ajoutez vos dates d'examens (titre contenant « examen » ou « partiel »).";
    return { title: "Plan de révisions", body, output: { exams: exams.length } };
  },
  async weekly_review(a) {
    const since = new Date(Date.now() - 7 * 86400_000);
    const done = await db.select().from(schema.tasks).where(and(eq(schema.tasks.ownerId, a.ownerId), eq(schema.tasks.status, "done"), gte(schema.tasks.completedAt, since)));
    const late = await db.select().from(schema.tasks).where(and(eq(schema.tasks.ownerId, a.ownerId), inArray(schema.tasks.status, ["todo", "doing"]), lt(schema.tasks.dueAt, new Date())));
    const next = await db.select().from(schema.tasks).where(and(eq(schema.tasks.ownerId, a.ownerId), inArray(schema.tasks.status, ["todo", "doing"]), gte(schema.tasks.dueAt, new Date()), lt(schema.tasks.dueAt, new Date(Date.now() + 7 * 86400_000))));
    const moved = await db.select().from(schema.opportunityStageHistory).where(gte(schema.opportunityStageHistory.changedAt, since));
    const body = [`**Réalisé (7 j)** : ${done.length} tâche(s)${done.length ? ` — ${done.map((t) => t.title).join(" ; ")}` : ""}`,
      `**En retard** : ${late.length}${late.length ? ` — ${late.map((t) => t.title).join(" ; ")}` : ""}`,
      `**Échéances des 7 prochains jours** : ${next.length}${next.length ? ` — ${next.map((t) => `${t.title} (${fmt(t.dueAt)})`).join(" ; ")}` : ""}`,
      `**CRM** : ${moved.length} changement(s) d'étape.`].join("\n");
    return { title: "Weekly Review", body, output: { done: done.length, late: late.length, next: next.length } };
  },
  async system_health(a) {
    const failed = await db.select().from(schema.automationRuns).where(and(eq(schema.automationRuns.status, "failed"), gte(schema.automationRuns.startedAt, new Date(Date.now() - 86400_000))));
    const failedRuns = (await db.execute(sql`SELECT count(*)::int AS n FROM agent_runs WHERE owner_id = ${a.ownerId} AND status = 'failed' AND created_at > now() - interval '1 day'`)).rows[0] as { n: number };
    const budget = await budgetState(a.ownerId);
    const integ = await integrityReport(a.ownerId);
    const expired = await expireMemories(a.ownerId);
    const contradictions = await findContradictionCandidates(a.ownerId);
    const plugins = await runPluginAudit(a.ownerId).catch((e) => ({ error: (e as Error).message }));
    const conns = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.ownerId, a.ownerId));
    const body = [
      `Automatisations en échec (24 h) : ${failed.length} · exécutions d'agents en échec : ${failedRuns.n}`,
      `Coûts IA : ${budget.dayUsd.toFixed(4)} $ aujourd'hui / ${budget.limits.dayUsd} $ ; ${budget.monthUsd.toFixed(4)} $ ce mois / ${budget.limits.monthUsd} $${budget.blocked ? ` — ⛔ ${budget.blocked}` : ""}`,
      `Intégrations : ${conns.filter((c) => c.status === "connected").length} connectée(s), ${conns.filter((c) => c.status === "error").length} en erreur, ${conns.filter((c) => c.status === "not_connected").length} non connectée(s)`,
      "error" in plugins ? `Audit plugins : échec (${plugins.error})` : `Extensions : ${plugins.updates} mise(s) à jour disponible(s), ${plugins.recommended} recommandation(s)`,
      `Graphe : ${integ.orphanNodes.length ? `${integ.orphanNodes.reduce((s, o) => s + o.count, 0)} nœud(s) orphelin(s)` : "aucun nœud orphelin"}, ${integ.entitiesWithoutNode.length ? "entités non synchronisées détectées" : "synchronisation complète"}`,
      `Mémoire : ${expired} souvenir(s) expiré(s) aujourd'hui, ${contradictions.length} contradiction(s) candidate(s) à arbitrer`,
    ].join("\n");
    return { title: "Santé du système", body, output: { failed: failed.length, integrity: integ, budget, plugins } };
  },
};

export async function runAutomation(automationId: string, trigger: "schedule" | "manual", attempt = 1) {
  const [a] = await db.select().from(schema.automations).where(eq(schema.automations.id, automationId));
  if (!a) throw new Error("Automatisation introuvable");
  if (!a.enabled && trigger === "schedule") return { status: "skipped" as const };
  const [run] = await db.insert(schema.automationRuns).values({ automationId, trigger, status: "running", attempt }).returning();
  try {
    const h = handlers[a.key];
    if (!h) throw new Error(`Aucun gestionnaire pour ${a.key}`);
    const r = await h(a);
    await db.update(schema.automationRuns).set({ status: r.skipped ? "skipped" : "completed", output: { ...r.output, title: r.title, body: r.body, skipped: r.skipped }, endedAt: new Date() }).where(eq(schema.automationRuns.id, run.id));
    await db.update(schema.automations).set({ lastRunAt: new Date() }).where(eq(schema.automations.id, a.id));
    await db.insert(schema.notifications).values({ ownerId: a.ownerId, kind: `automation:${a.key}`, title: r.title, body: r.body, link: "/automations" });
    return { status: r.skipped ? ("skipped" as const) : ("completed" as const), runId: run.id };
  } catch (e) {
    await db.update(schema.automationRuns).set({ status: "failed", error: (e as Error).message, endedAt: new Date() }).where(eq(schema.automationRuns.id, run.id));
    throw e; // pg-boss gère les nouvelles tentatives (retryLimit)
  }
}

export async function recentAutomationRuns(ownerId: string, limit = 30) {
  return db.select({ run: schema.automationRuns, name: schema.automations.name, key: schema.automations.key }).from(schema.automationRuns)
    .innerJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
    .where(eq(schema.automations.ownerId, ownerId)).orderBy(desc(schema.automationRuns.startedAt)).limit(limit);
}
void addStep;
