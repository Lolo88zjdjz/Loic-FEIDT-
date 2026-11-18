/**
 * Gestionnaires déterministes : réponses fondées UNIQUEMENT sur les données
 * stockées, via les mêmes outils (et le même contrôle SENTINEL) que les LLM.
 * Aucun texte n'est « généré » : les réponses sont assemblées à partir des
 * résultats d'outils. Utilisés sans clé API, et pour les intentions simples
 * même avec clé (économie de tokens).
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { AGENTS } from "../agents/definitions";
import { findContradictionCandidates } from "../memory/service";
import { addStep, executeTool, getAgent, type AgentRecord } from "./engine";
import type { Intent } from "./intent";

export type DetResult = { reply: string; sources: { kind: string; label: string; ref?: string }[]; status: "completed" | "waiting_approval" | "failed"; data?: unknown; needsLlm?: string };

type Ctx = { ownerId: string; runId: string; agent: AgentRecord };

async function call<T = unknown>(ctx: Ctx, tool: string, input: Record<string, unknown>): Promise<{ ok: true; out: T } | { ok: false; msg: string; approvalId?: string }> {
  await addStep(ctx.runId, { kind: "tool_call", agentId: ctx.agent.id, summary: `${tool}(${JSON.stringify(input).slice(0, 120)})`, data: { tool, input } });
  const r = await executeTool(ctx, tool, input);
  if (r.status === "ok") return { ok: true, out: r.output as T };
  if (r.status === "waiting_approval") return { ok: false, msg: `Action en attente de validation (${r.reason}).`, approvalId: r.approvalId };
  return { ok: false, msg: r.status === "denied" ? r.reason : r.error };
}

const fmtDate = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—");
const stageFr: Record<string, string> = { identified: "Identifié", researched: "Étudié", contacted: "Contacté", replied: "A répondu", negotiating: "En négociation", agreed: "Accord", declined: "Refusé", delivered: "Livré", closed: "Clos", targeted: "Ciblé", applied: "Candidature envoyée", acknowledged: "Accusé de réception", interview: "Entretien", offer: "Offre", rejected: "Refusé", withdrawn: "Retiré" };

export async function runDeterministic(ownerId: string, runId: string, agentId: string, intent: Intent): Promise<DetResult> {
  const agent = await getAgent(agentId);
  const ctx: Ctx = { ownerId, runId, agent };

  switch (intent.kind) {
    case "nutrition_log": {
      const r = await call<{ food: { name: string; dataStatus: string; sourceNote: string }; macros: { kcal: number; protein: number; carbs: number; fat: number }; day: { kcal: number; protein: number; carbs: number; fat: number; status: string } }>(ctx, "nutrition_log", { food: intent.food, grams: intent.grams });
      if (!r.ok) return { reply: r.msg, sources: [], status: r.approvalId ? "waiting_approval" : "failed" };
      const { food, macros, day } = r.out;
      const est = food.dataStatus === "estimated";
      return {
        status: "completed", data: r.out,
        sources: [{ kind: "food", label: `${food.name} — ${est ? "valeurs estimées" : "valeurs vérifiées"} (${food.sourceNote})` }],
        reply: [`✅ Ajouté : **${intent.grams} g de ${food.name}**`, "",
          `| | kcal | Protéines | Glucides | Lipides |`, `|---|---|---|---|---|`,
          `| Cette entrée | ${macros.kcal} | ${macros.protein} g | ${macros.carbs} g | ${macros.fat} g |`,
          `| Total du jour | ${day.kcal} | ${day.protein} g | ${day.carbs} g | ${day.fat} g |`, "",
          est ? "⚠️ Valeurs **estimées** (référence générique) : saisissez celles de l'étiquette dans Paramètres → Nutrition pour les passer en « vérifiées »." : "Valeurs vérifiées (étiquette saisie).",
          day.status === "estimated" && !est ? "Le total du jour contient au moins une estimation." : ""].filter(Boolean).join("\n"),
      };
    }
    case "nutrition_day": {
      const r = await call<{ totals: { kcal: number; protein: number; carbs: number; fat: number; entries: number; status: string } }>(ctx, "nutrition_day", {});
      if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
      const t = r.out.totals;
      return { status: "completed", sources: [{ kind: "food_log", label: "Journal alimentaire du jour" }],
        reply: t.entries ? `Aujourd'hui (${t.entries} entrées) : **${t.kcal} kcal**, ${t.protein} g de protéines, ${t.carbs} g de glucides, ${t.fat} g de lipides${t.status === "estimated" ? " — contient des estimations" : ""}.` : "Aucune entrée dans le journal aujourd'hui." };
    }
    case "task_create": {
      const r = await call<{ id: string; project: string | null }>(ctx, "task_create", { title: intent.title });
      if (!r.ok) return { reply: r.msg, sources: [], status: r.approvalId ? "waiting_approval" : "failed" };
      return { status: "completed", sources: [], reply: `✅ Tâche créée : « ${intent.title} ». Vous pouvez lui associer un projet et une échéance dans **Projets**.` };
    }
    case "memory_remember": {
      const r = await call<{ id: string }>(ctx, "memory_create", { content: intent.content, type: "semantic", category: guessCategory(intent.content), confidenceStatus: "user_confirmed" });
      if (!r.ok) return { reply: r.msg, sources: [], status: r.approvalId ? "waiting_approval" : "failed" };
      return { status: "completed", sources: [{ kind: "memory", label: "Nouveau souvenir", ref: r.out.id }], reply: `🧠 Mémorisé (catégorie « ${guessCategory(intent.content)} », confirmé par vous, daté d'aujourd'hui). Modifiable dans **Memory**.` };
    }
    case "overview": return overview(ctx);
    case "overdue": {
      const r = await call<{ title: string; project: string | null; dueAt: string | null; priority: number }[]>(ctx, "tasks_list", {});
      const p = await call<{ name: string; overdue: number; openTasks: number }[]>(ctx, "projects_overview", {});
      if (!r.ok || !p.ok) return { reply: "Lecture des tâches impossible.", sources: [], status: "failed" };
      const late = r.out.filter((t) => t.dueAt && new Date(t.dueAt) < new Date());
      const lateProjects = p.out.filter((x) => x.overdue > 0);
      return { status: "completed", sources: [{ kind: "tasks", label: "Tâches en base" }],
        reply: late.length ? [`**${late.length} tâche(s) en retard** dans ${lateProjects.length} projet(s) :`, ...late.map((t) => `- ${t.title} — ${t.project ?? "sans projet"} (échéance ${fmtDate(t.dueAt)})`)].join("\n")
          : `Aucune tâche en retard. ${r.out.length} tâche(s) ouverte(s) au total.` };
    }
    case "graph_connections": {
      const r = await call<{ from: string; to: string; paths: { hops: number; explanation: string[]; containsInferred: boolean; provenance: string[] }[]; error?: string }>(ctx, "graph_paths", { from: intent.a, to: intent.b, maxHops: 4 });
      if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
      if (r.out.error) return { reply: `${r.out.error}. Vérifiez le nom dans **Neural Brain**.`, sources: [], status: "completed" };
      const { paths } = r.out;
      if (!paths.length) return { reply: `Aucun chemin trouvé entre **${r.out.from}** et **${r.out.to}** (≤ 4 relations).`, sources: [], status: "completed" };
      return {
        status: "completed", data: { highlight: [r.out.from, r.out.to] },
        sources: [{ kind: "graph", label: `Graphe : ${paths.length} chemin(s)` }],
        reply: [`**${paths.length} chemin(s)** entre ${r.out.from} et ${r.out.to} :`, "",
          ...paths.slice(0, 8).map((p, i) => `${i + 1}. ${p.explanation.join(" · ")}${p.containsInferred ? " — _contient une relation inférée (hypothèse)_" : ""}`),
          "", "Chaque relation est cliquable dans **Neural Brain** pour voir sa provenance. Les relations « inférées » sont des hypothèses, pas des faits."].join("\n"),
      };
    }
    case "graph_projects": {
      const projects = await db.select().from(schema.projects).where(eq(schema.projects.ownerId, ownerId));
      const lines: string[] = [];
      for (let i = 0; i < projects.length; i++) for (let j = i + 1; j < projects.length; j++) {
        const r = await call<{ paths: { explanation: string[]; hops: number }[] }>(ctx, "graph_paths", { from: projects[i].name, to: projects[j].name, maxHops: 3 });
        if (r.ok && r.out.paths?.length) lines.push(`- **${projects[i].name} ↔ ${projects[j].name}** : ${r.out.paths[0].explanation.join(" · ")}`);
        if (lines.length >= 10) break;
      }
      return { status: "completed", sources: [{ kind: "graph", label: "Graphe de connaissances" }], data: { view: "projects" },
        reply: lines.length ? ["Connexions directes ou courtes (≤ 3 relations) entre vos projets :", ...lines, "", "→ Ouvrez **Neural Brain** filtré sur le type « Project » pour la vue interactive."].join("\n") : "Aucune connexion courte entre projets dans le graphe actuel." };
    }
    case "org_dossier": return orgDossier(ctx, intent.name);
    case "followup_draft": return followupDraft(ctx, intent.name);
    case "stale_partnerships": {
      const r = await call<{ title: string; organization: string; stage: string; lastInteractionAt: string | null }[]>(ctx, "crm_stale", { days: 10 });
      if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
      return { status: "completed", sources: [{ kind: "crm", label: "CRM — partenariats" }],
        reply: r.out.length ? ["Partenariats en cours sans interaction datée depuis plus de 10 jours :", ...r.out.map((o) => `- **${o.organization}** — ${o.title} (${stageFr[o.stage] ?? o.stage}, dernier échange : ${o.lastInteractionAt ? fmtDate(o.lastInteractionAt) : "date inconnue"})`), "", "Écrivez « Prépare une relance pour <marque> » pour obtenir un brouillon."].join("\n") : "Aucune discussion en attente de relance." };
    }
    case "costs": {
      const r = await call<{ apiCalls: number; totalCostUsd: number; byAgent: Record<string, { calls: number; costUsd: number }>; byModel: Record<string, { calls: number; costUsd: number }>; missions: { mode: string; status: string; n: number }[]; avgCostPerCompletedMissionUsd: number | null }>(ctx, "costs_report", { days: 30 });
      if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
      const c = r.out;
      const det = c.missions.filter((m) => m.mode === "deterministic").reduce((s, m) => s + m.n, 0);
      const llm = c.missions.filter((m) => m.mode === "llm").reduce((s, m) => s + m.n, 0);
      const top = Object.entries(c.byAgent).sort((a, b) => b[1].costUsd - a[1].costUsd).slice(0, 5);
      return { status: "completed", sources: [{ kind: "model_usage", label: "Table model_usage (tokens mesurés)" }],
        reply: [`**Consommation IA mesurée (30 j)** : ${c.apiCalls} appel(s) API, **${c.totalCostUsd.toFixed(4)} $**.`,
          `Missions : ${det} en mode déterministe (0 $), ${llm} via LLM.`,
          c.avgCostPerCompletedMissionUsd !== null ? `Coût moyen par mission réussie : ${c.avgCostPerCompletedMissionUsd.toFixed(4)} $.` : "",
          top.length ? ["", "Agents les plus coûteux :", ...top.map(([a, v]) => `- ${a} : ${v.costUsd.toFixed(4)} $ (${v.calls} appels)`)].join("\n") : "",
          "", c.apiCalls === 0 ? "Aucune donnée d'appel API : aucune optimisation chiffrée ne peut être proposée pour l'instant (pas d'économie fictive)." : "Recommandations détaillées : **AI Cost Center**."].filter(Boolean).join("\n") };
    }
    case "plugins": {
      const r = await call<{ name: string; kind: string; status: string; installed: string | null; latest: string | null; function: string }[]>(ctx, "plugins_audit", {});
      if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
      const by = (s: string) => r.out.filter((p) => p.status === s);
      return { status: "completed", sources: [{ kind: "plugins", label: "Inventaire Plugin Center" }],
        reply: [`**Inventaire vérifié** : ${by("installed").length} installés, ${by("update_available").length} mises à jour disponibles, ${by("recommended").length} recommandés, ${by("available").length} disponibles non configurés.`,
          ...by("update_available").map((p) => `- ⬆️ ${p.name} ${p.installed} → ${p.latest}`),
          ...by("recommended").map((p) => `- ⭐ ${p.name} — ${p.function}`),
          ...by("available").map((p) => `- ○ ${p.name} — ${p.function}`),
          "", "Aucune installation n'est effectuée automatiquement. Détails, risques et permissions : **Plugin Center**."].join("\n") };
    }
    case "contradictions": {
      const c = await findContradictionCandidates(ownerId);
      await addStep(runId, { kind: "validation", agentId: "sentinel", summary: `${c.length} paire(s) de souvenirs proches à vérifier` });
      return { status: "completed", sources: [{ kind: "memory", label: "Analyse de similarité (pg_trgm)" }],
        reply: c.length ? ["Paires de souvenirs similaires mais différents (contradictions **possibles**, à arbitrer) :", ...c.slice(0, 8).map((x) => `- [${x.category}] « ${x.a_content.slice(0, 90)} » (${x.a_obs}) ↔ « ${x.b_content.slice(0, 90)} » (${x.b_obs})`), "", "Arbitrez dans **Memory → Contradictions** (remplacer, fusionner ou conserver)."].join("\n") : "Aucune contradiction candidate détectée." };
    }
    case "docs_query": {
      const r = await call<{ title: string; excerpt: string; page: number | null; documentId: string }[]>(ctx, "docs_search", { query: intent.query, limit: 8 });
      if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
      const titles = [...new Map(r.out.map((c) => [c.documentId, c])).values()];
      return { status: "completed", sources: titles.map((c) => ({ kind: "document", label: c.title, ref: c.documentId })),
        reply: titles.length ? [`Documents mentionnant « ${intent.query} » :`, ...titles.map((c) => `- **${c.title}**${c.page ? ` (p. ${c.page})` : ""} — ${c.excerpt}`)].join("\n") : `Aucun document importé ne mentionne « ${intent.query} ».` };
    }
    case "network_career": return networkCareer(ctx);
    case "tools_by_agent": {
      const users = AGENTS.filter((a) => a.tools.some((t) => t.includes(intent.tool.toLowerCase().replace(/\s+/g, "_"))));
      return { status: "completed", sources: [{ kind: "agents", label: "Registre des agents" }],
        reply: users.length ? `Agents autorisés à utiliser un outil correspondant à « ${intent.tool} » : ${users.map((a) => a.name).join(", ")}.` : `Aucun agent n'utilise d'outil correspondant à « ${intent.tool} ».` };
    }
    case "skills": {
      const nodes = await db.select().from(schema.graphNodes).where(and(eq(schema.graphNodes.ownerId, ownerId), eq(schema.graphNodes.type, "Skill"), eq(schema.graphNodes.status, "active")));
      return { status: "completed", sources: [{ kind: "graph", label: "Nœuds Skill du graphe" }],
        reply: nodes.length ? ["Compétences enregistrées dans votre graphe (avec leur origine) :", ...nodes.map((n) => `- **${n.label}**${n.description ? ` — ${n.description}` : ""}`)].join("\n") : "Aucune compétence enregistrée." };
    }
    case "open":
      return { status: "completed", sources: [], needsLlm: "Demande ouverte : une réponse rédigée nécessite un modèle IA." , reply: "" };
  }
}

function guessCategory(text: string) {
  const t = text.toLowerCase();
  if (/(stage|cv|candidat|carri|recrut)/.test(t)) return "career";
  if (/(partenai|sponsor|altigliss|dotation)/.test(t)) return "partnerships";
  if (/(cours|examen|partiel|gem|l3)/.test(t)) return "education";
  if (/(muscu|handball|trail|ski|course)/.test(t)) return "sport";
  if (/(manger|protéine|kcal|repas)/.test(t)) return "nutrition";
  if (/(voyage|thaïlande|vol)/.test(t)) return "travel";
  if (/(préf|réponse|ton|style)/.test(t)) return "communication";
  return "identity";
}

async function overview(ctx: Ctx): Promise<DetResult> {
  const [p, t, c, ev] = await Promise.all([
    call<{ name: string; status: string; openTasks: number; overdue: number }[]>(ctx, "projects_overview", {}),
    call<{ title: string; project: string | null; dueAt: string | null; priority: number }[]>(ctx, "tasks_list", {}),
    call<{ title: string; organization: string; pipeline: string; stage: string; nextAction: string | null }[]>(ctx, "crm_overview", {}),
    call<{ events: { title: string; startsAt: string; status: string }[]; conflicts: [string, string][] }>(ctx, "calendar_upcoming", { days: 60 }),
  ]);
  const pending = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.ownerId, ctx.ownerId), eq(schema.approvalRequests.status, "pending")));
  const lines: string[] = ["## Point global", ""];
  if (p.ok) {
    lines.push("**Projets**");
    for (const x of p.out) lines.push(`- ${x.name} — ${x.openTasks} tâche(s) ouverte(s)${x.overdue ? `, ⚠️ ${x.overdue} en retard` : ""}`);
  }
  if (t.ok) {
    const soon = t.out.filter((x) => x.dueAt).slice(0, 5);
    if (soon.length) { lines.push("", "**Prochaines échéances**"); soon.forEach((x) => lines.push(`- ${fmtDate(x.dueAt)} — ${x.title}${x.project ? ` (${x.project})` : ""}`)); }
    const urgent = t.out.filter((x) => x.priority === 1 && !x.dueAt);
    if (urgent.length) { lines.push("", "**Prioritaires sans échéance**"); urgent.forEach((x) => lines.push(`- ${x.title}`)); }
  }
  if (c.ok) {
    const active = c.out.filter((o) => ["contacted", "replied", "negotiating", "agreed"].includes(o.stage));
    if (active.length) { lines.push("", "**Partenariats actifs**"); active.forEach((o) => lines.push(`- ${o.organization} : ${stageFr[o.stage] ?? o.stage}${o.nextAction ? ` → ${o.nextAction}` : ""}`)); }
    const apps = c.out.filter((o) => o.pipeline === "application");
    lines.push("", `**Candidatures** : ${apps.length ? apps.map((a) => `${a.organization} (${stageFr[a.stage] ?? a.stage})`).join(", ") : "aucune enregistrée pour l'instant"}.`);
  }
  if (ev.ok && ev.out.events.length) { lines.push("", "**Agenda (60 j)**"); ev.out.events.slice(0, 5).forEach((e) => lines.push(`- ${fmtDate(e.startsAt)} — ${e.title} (${e.status})`)); if (ev.out.conflicts.length) lines.push(`⚠️ ${ev.out.conflicts.length} conflit(s) horaire(s).`); }
  if (pending.length) lines.push("", `**${pending.length} action(s) en attente de votre validation** → Activity.`);
  lines.push("", "_Synthèse assemblée à partir de vos données (mode déterministe, sans IA générative)._");
  return { status: "completed", reply: lines.join("\n"), sources: [{ kind: "projects", label: "Projets & tâches" }, { kind: "crm", label: "CRM" }, { kind: "calendar", label: "Calendrier" }] };
}

type Dossier = { org: { name: string; sector: string | null; notes: string | null }; contacts: { fullName: string; role: string | null; email: string | null }[];
  opportunities: { title: string; stage: string; valueNote: string | null; nextAction: string | null; pipeline: string }[];
  interactions: { summary: string; occurredOn: string | null; datePrecision: string; channel: string }[]; error?: string };

async function orgDossier(ctx: Ctx, name: string): Promise<DetResult> {
  const r = await call<Dossier>(ctx, "crm_org_dossier", { name });
  if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
  if (r.out.error) return { reply: `Je n'ai aucune fiche CRM pour « ${name} ». Rien n'est inventé : ajoutez l'organisation dans **CRM** si besoin.`, sources: [], status: "completed" };
  const d = r.out;
  const mem = await call<{ content: string; observedAt: string; confidence: string }[]>(ctx, "memory_search", { query: d.org.name, limit: 6 });
  return {
    status: "completed", data: { highlight: [d.org.name] },
    sources: [{ kind: "crm", label: `Fiche CRM ${d.org.name}` }, ...(mem.ok ? mem.out.map((m) => ({ kind: "memory", label: `Souvenir du ${m.observedAt}` })) : [])],
    reply: [`## ${d.org.name}${d.org.sector ? ` · ${d.org.sector}` : ""}`, d.org.notes ? `\n${d.org.notes}` : "",
      d.contacts.length ? `\n**Contacts** : ${d.contacts.map((c) => `${c.fullName}${c.role ? ` (${c.role})` : ""}`).join(", ")}` : "\n**Contacts** : aucun enregistré.",
      d.opportunities.length ? `\n**Opportunités**\n${d.opportunities.map((o) => `- ${o.title} — ${stageFr[o.stage] ?? o.stage}${o.valueNote ? `\n  ${o.valueNote}` : ""}${o.nextAction ? `\n  → Prochaine action : ${o.nextAction}` : ""}`).join("\n")}` : "",
      d.interactions.length ? `\n**Historique des échanges**\n${d.interactions.map((i) => `- ${i.occurredOn ? (i.datePrecision === "month" ? i.occurredOn.slice(0, 7) : i.occurredOn) : "date inconnue"} · ${i.channel} — ${i.summary}`).join("\n")}` : "",
      mem.ok && mem.out.length ? `\n**Mémoire associée**\n${mem.out.map((m) => `- ${m.content} _(observé ${m.observedAt}, ${m.confidence === "imported_historical" ? "historique importé" : m.confidence})_`).join("\n")}` : "",
      "\n_Les montants et conditions ci-dessus sont historiques : à reconfirmer avant tout usage._"].join("\n"),
  };
}

async function followupDraft(ctx: Ctx, name: string): Promise<DetResult> {
  const r = await call<Dossier>(ctx, "crm_org_dossier", { name });
  if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
  if (r.out.error) return { reply: `Aucune fiche CRM pour « ${name} » : impossible de préparer une relance fondée sur l'historique.`, sources: [], status: "completed" };
  const d = r.out;
  const contact = d.contacts[0];
  const last = d.interactions[0];
  const opp = d.opportunities.find((o) => o.pipeline === "partnership");
  const subject = `Altigliss Challenge — suite de nos échanges${opp ? "" : ""}`;
  const body = [
    `Bonjour${contact ? ` ${contact.fullName.split(" ")[0]}` : ""},`, "",
    `Je reviens vers vous au sujet ${opp ? `de notre projet « ${opp.title} »` : "d'un partenariat pour le GEM Altigliss Challenge"}${last ? `, suite à notre dernier échange${last.occurredOn ? ` (${last.datePrecision === "month" ? last.occurredOn.slice(0, 7) : last.occurredOn})` : ""}` : ""}.`, "",
    "[À COMPLÉTER : point précis à faire avancer — ex. validation des quantités, date de livraison, contreparties de visibilité]", "",
    "Je reste disponible pour un court échange si cela vous facilite les choses.", "", "Bien à vous,", "Loïc", "Responsable partenariats — Altigliss (GEM)",
  ].join("\n");
  await addStep(ctx.runId, { kind: "llm_call", agentId: "wordsmith", summary: "Brouillon assemblé par modèle de texte (aucun appel IA)", data: { template: "followup_v1" } });
  const draft = await call<{ draftId: string | null }>(await asAgent(ctx, "dealmaker"), "draft_email", { to: contact?.email ?? "", subject, body, organization: d.org.name });
  return {
    status: draft.ok ? "waiting_approval" : "failed",
    sources: [{ kind: "crm", label: `Fiche CRM ${d.org.name}` }],
    reply: [`**Contexte (${d.org.name})** : ${opp ? `${opp.title} — ${stageFr[opp.stage] ?? opp.stage}` : "pas d'opportunité ouverte"}. Dernier échange : ${last ? last.summary : "aucun enregistré"}.`,
      "", "**Brouillon de relance** (modèle de texte, sans IA — à personnaliser) :", "", "```", `Objet : ${subject}`, "", body, "```", "",
      contact?.email ? "" : "⚠️ Aucune adresse e-mail connue pour ce contact : je n'en invente pas. Complétez-la avant envoi.",
      "Le brouillon est en attente dans **Activity → Approbations**. Rien ne sera envoyé sans votre validation (Gmail non connecté)."].filter(Boolean).join("\n"),
  };
}
async function asAgent(ctx: Ctx, id: string): Promise<Ctx> { return { ...ctx, agent: await getAgent(id) }; }

async function networkCareer(ctx: Ctx): Promise<DetResult> {
  const r = await call<{ title: string; organization: string; pipeline: string; stage: string }[]>(ctx, "crm_overview", {});
  const goals = await call<{ content: string; observedAt: string }[]>(ctx, "memory_search", { query: "stage sales business development marques", limit: 5 });
  if (!r.ok) return { reply: r.msg, sources: [], status: "failed" };
  const relations = r.out.filter((o) => ["replied", "negotiating", "agreed", "delivered"].includes(o.stage));
  return {
    status: "completed", sources: [{ kind: "crm", label: "CRM" }, { kind: "memory", label: "Objectifs carrière (mémoire)" }],
    reply: ["**Faits** — organisations avec lesquelles une relation réelle existe (échanges enregistrés) :",
      ...(relations.length ? relations.map((o) => `- ${o.organization} (${stageFr[o.stage] ?? o.stage} — ${o.title})`) : ["- aucune"]),
      "", "**Objectifs carrière en mémoire** :", ...(goals.ok ? goals.out.map((g) => `- ${g.content} _(observé ${g.observedAt})_`) : []),
      "", "**Hypothèse** — ces relations peuvent servir de pistes de networking pour un stage (sales, wholesale, business development…). Aucune n'indique une offre d'emploi : à valider par une prise de contact.",
      "", "Pour un classement argumenté et une recherche d'offres réelles, NEXUS a besoin d'un modèle IA et de la recherche web (clé API)."].join("\n"),
  };
}

export const DETERMINISTIC_AGENTS = AGENTS.map((a) => a.id);
