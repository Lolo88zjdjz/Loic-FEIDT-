/**
 * Routage déterministe (sans appel IA) : reconnaît les intentions fréquentes
 * et choisit l'agent. Il sert à la fois de mode dégradé (pas de clé API) et
 * d'économie de tokens (une intention reconnue n'a pas besoin d'un LLM pour
 * être routée). Résultat explicable : mots-clés déclencheurs renvoyés.
 */
import { AGENTS } from "../agents/definitions";
import type { TaskProfile } from "../model-router/router";
import { norm } from "../shared";

export type Intent =
  | { kind: "nutrition_log"; grams: number; food: string }
  | { kind: "nutrition_day" }
  | { kind: "task_create"; title: string; due?: string }
  | { kind: "memory_remember"; content: string }
  | { kind: "overview" }
  | { kind: "graph_connections"; a: string; b: string }
  | { kind: "graph_projects" }
  | { kind: "org_dossier"; name: string }
  | { kind: "followup_draft"; name: string }
  | { kind: "stale_partnerships" }
  | { kind: "overdue" }
  | { kind: "costs" }
  | { kind: "plugins" }
  | { kind: "contradictions" }
  | { kind: "docs_query"; query: string }
  | { kind: "network_career" }
  | { kind: "tools_by_agent"; tool: string }
  | { kind: "skills" }
  | { kind: "open"; text: string };

export type Route = { agentId: string; intent: Intent; profile: TaskProfile; matched: string[]; confidence: "rule" | "keywords" | "default" };

const strip = (s: string) => s.replace(/^\s*(atlas|nexus|dealmaker|scholar|athena|vital|nutri|nomad|capital|flow|wordsmith|forge|sentinel|oracle)\s*[,:]\s*/i, "").trim();

export function detectIntent(raw: string): Intent {
  const text = strip(raw);
  const n = norm(text);
  let m: RegExpMatchArray | null;

  if ((m = text.match(/(?:ajoute|note|enregistre|log)\s+(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grammes?)\s*(?:de |d'|d’)?\s*(.+?)(?:\s+(?:à|a|dans|au)\s+(?:mon\s+)?journal.*)?[.!]?$/i))) {
    const q = parseFloat(m[1].replace(",", "."));
    return { kind: "nutrition_log", grams: m[2].toLowerCase() === "kg" ? q * 1000 : q, food: m[3].trim() };
  }
  if (/(journal alimentaire|combien de (proteines|calories)|mes macros|bilan nutrition)/.test(n)) return { kind: "nutrition_day" };
  if ((m = text.match(/^(?:cr[ée]e|ajoute)\s+(?:une\s+)?t[âa]che\s*[:\-]?\s*(.+)$/i))) return { kind: "task_create", title: m[1].trim() };
  if ((m = text.match(/^(?:souviens-toi|rappelle-toi|retiens|m[ée]morise)\s+(?:que\s+|qu')?(.+)$/i))) return { kind: "memory_remember", content: m[1].trim() };
  if (/(point global|fais[- ]moi un point|vue d'ensemble|ou j'en suis|(mon|le|un) briefing( du jour)?$)/.test(n)) return { kind: "overview" };
  if ((m = text.match(/connexions?\s+entre\s+(.+?)\s+et\s+(.+?)[.?!]?$/i)) && !/mes projets/i.test(m[1])) return { kind: "graph_connections", a: cleanEntity(m[1]), b: cleanEntity(m[2]) };
  if (/connexions?\s+entre\s+(tous\s+)?mes projets/.test(n)) return { kind: "graph_projects" };
  if ((m = text.match(/(?:relance|relancer)\s+(?:pour\s+|de\s+|chez\s+)?(?:la marque\s+|l'entreprise\s+)?(.+?)[.?!]?$/i)) && !/^une marque avec/i.test(m[1])) return { kind: "followup_draft", name: cleanEntity(m[1]) };
  if (/(sans r[ée]ponse|a relancer|à relancer|relances? en attente|discussions? en attente|marque avec laquelle je n[ée]gocie)/.test(n)) return { kind: "stale_partnerships" };
  if ((m = text.match(/(?:que sais-tu|qu'est-ce que tu sais|dossier|historique)\s+(?:de|sur|des|du)?\s*(?:mes\s+)?(?:discussions?|[ée]changes?|relations?)?\s*(?:avec|de|sur)?\s+(.+?)[.?!]?$/i))) return { kind: "org_dossier", name: cleanEntity(m[1]) };
  if (/(en retard|deadlines? depass|echeances? depass)/.test(n)) return { kind: "overdue" };
  if (/(consommation|cout|tokens?|depenses ia|optimise les agents)/.test(n)) return { kind: "costs" };
  if (/(plugin|extension|connecteur|mcp|outils? manquants?)/.test(n)) return { kind: "plugins" };
  if (/(contradiction|incoherence)/.test(n)) return { kind: "contradictions" };
  if ((m = text.match(/quels? documents?\s+(?:parlent|traitent|mentionnent)\s+(?:de\s+|d'|du\s+|des\s+)?(.+?)[.?!]?$/i))) return { kind: "docs_query", query: m[1].trim() };
  if (/(entreprises?|organisations?) de mon reseau.*(carriere|stage)|reseau.*pertinent/.test(n) || /quelles entreprises sont connectees/.test(n)) return { kind: "network_career" };
  if ((m = text.match(/quels agents utilisent\s+(?:l'outil\s+|cet outil\s+)?(.+?)[.?!]?$/i))) return { kind: "tools_by_agent", tool: m[1].trim() };
  if (/quelles competences/.test(n)) return { kind: "skills" };
  return { kind: "open", text };
}

function cleanEntity(s: string) {
  return s.replace(/^(?:l'|la |le |les |mon |ma |mes |une |un )/i, "").replace(/^(?:entreprise|marque|projet|association)\s+/i, "").trim();
}

const INTENT_AGENT: Record<Intent["kind"], string> = {
  nutrition_log: "nutri", nutrition_day: "nutri", task_create: "flow", memory_remember: "atlas", overview: "atlas",
  graph_connections: "oracle", graph_projects: "oracle", org_dossier: "dealmaker", followup_draft: "dealmaker", stale_partnerships: "dealmaker",
  overdue: "flow", costs: "token_master", plugins: "plugin_architect", contradictions: "sentinel", docs_query: "scholar",
  network_career: "nexus", tools_by_agent: "atlas", skills: "atlas", open: "atlas",
};

export function route(text: string, forcedAgent?: string | null): Route {
  const intent = detectIntent(text);
  if (forcedAgent) return { agentId: forcedAgent, intent, profile: profileFor(intent, text), matched: ["sélection manuelle"], confidence: "rule" };
  if (intent.kind !== "open") return { agentId: INTENT_AGENT[intent.kind], intent, profile: profileFor(intent, text), matched: [`intention:${intent.kind}`], confidence: "rule" };
  // Intention ouverte : score par mots-clés des agents.
  const n = norm(text);
  let best = { id: "atlas", score: 0, matched: [] as string[] };
  for (const a of AGENTS) {
    if (a.id === "atlas") continue;
    const matched = a.keywords.filter((k) => n.includes(norm(k)));
    // Un verbe d'action en tête de phrase pèse plus lourd que les sujets mentionnés.
    const score = matched.reduce((s, k) => s + k.length * (n.startsWith(norm(k)) ? 3 : 1), 0);
    if (score > best.score) best = { id: a.id, score, matched };
  }
  return best.score > 0
    ? { agentId: best.id, intent, profile: profileFor(intent, text), matched: best.matched, confidence: "keywords" }
    : { agentId: "atlas", intent, profile: profileFor(intent, text), matched: [], confidence: "default" };
}

export function profileFor(intent: Intent, text: string): TaskProfile {
  const n = norm(text);
  const needsWeb = /(cherche|trouve|recherche|offres?|actualit|veille|en ligne|internet)/.test(n) && !/(mes documents|ma memoire|mon cerveau|recherche memoire|dans (ma|la) memoire|mon crm)/.test(n);
  const high = /(strateg|arbitr|long terme|architecture|analyse approfondie|toutes? (les )?connexions|tout ce que tu sais)/.test(n) || text.length > 1200;
  const risk = /(envoie|publie|reserve|paye|achete|supprime|installe)/.test(n) ? "high" : "low";
  const simple = ["nutrition_log", "nutrition_day", "task_create", "memory_remember", "overdue", "costs"].includes(intent.kind);
  return { complexity: high ? "high" : simple ? "low" : "medium", risk, needsWeb, contextTokens: Math.ceil(text.length / 4) };
}
