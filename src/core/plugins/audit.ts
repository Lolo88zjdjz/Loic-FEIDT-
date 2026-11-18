/**
 * PLUGIN ARCHITECT — inventaire RÉEL et vérifié.
 *  - Dépendances npm : version installée lue dans node_modules, dernière
 *    version lue en direct sur registry.npmjs.org (si le réseau le permet).
 *  - Outils internes : registre TOOLS.
 *  - Outils serveur Anthropic : documentés, utilisables seulement avec clé.
 *  - Intégrations candidates : listées uniquement si le paquet officiel
 *    existe sur le registre au moment de l'audit (sinon non listées).
 * Aucune installation n'est jamais déclenchée par cet audit.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db, schema } from "../db/client";
import { TOOLS } from "../agents/tools";
import { AGENTS } from "../agents/definitions";
import { audit } from "../security/audit";

type Row = typeof schema.pluginDefinitions.$inferInsert;

async function registryLatest(pkg: string): Promise<{ version: string | null; error?: string }> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } });
    if (res.status === 404) return { version: null, error: "absent du registre npm" };
    if (!res.ok) return { version: null, error: `registre npm : HTTP ${res.status}` };
    return { version: ((await res.json()) as { version: string }).version };
  } catch (e) { return { version: null, error: `registre injoignable (${(e as Error).name})` }; }
}

async function installedVersion(pkg: string) {
  try { return (JSON.parse(await readFile(path.join(process.cwd(), "node_modules", pkg, "package.json"), "utf8")) as { version: string }).version; }
  catch { return null; }
}

const cmp = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

const DEP_INFO: Record<string, { fn: string; agents: string[]; risks: string }> = {
  "@anthropic-ai/sdk": { fn: "SDK officiel de l'API Claude (appels des agents)", agents: AGENTS.map((a) => a.id), risks: "Facturation API ; clé à protéger" },
  "drizzle-orm": { fn: "ORM PostgreSQL typé", agents: [], risks: "Faible" },
  pg: { fn: "Pilote PostgreSQL", agents: [], risks: "Faible" },
  "pg-boss": { fn: "File de tâches et planificateur durables (PostgreSQL)", agents: ["flow"], risks: "Faible" },
  cytoscape: { fn: "Visualisation du graphe (Neural Brain)", agents: [], risks: "Faible (client)" },
  "cytoscape-fcose": { fn: "Disposition force-directed du graphe", agents: [], risks: "Faible (client)" },
  mammoth: { fn: "Extraction de texte DOCX", agents: ["scholar"], risks: "Traite des fichiers non fiables (texte uniquement)" },
  unpdf: { fn: "Extraction de texte PDF", agents: ["scholar"], risks: "Traite des fichiers non fiables (texte uniquement)" },
  zod: { fn: "Validation des entrées (API, outils, LLM)", agents: [], risks: "Faible" },
  bcryptjs: { fn: "Hachage des mots de passe", agents: [], risks: "Faible" },
  next: { fn: "Framework web (interface + API)", agents: [], risks: "Surveiller les avis de sécurité" },
  react: { fn: "Interface", agents: [], risks: "Faible" },
};

export async function runPluginAudit(ownerId: string) {
  const now = new Date();
  const pkgJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const rows: Row[] = [];

  for (const dep of Object.keys(pkgJson.dependencies)) {
    const [inst, latest] = await Promise.all([installedVersion(dep), registryLatest(dep)]);
    const info = DEP_INFO[dep] ?? { fn: "Dépendance applicative", agents: [], risks: "À évaluer" };
    rows.push({ id: `npm:${dep}`, name: dep, kind: "npm", provider: "npm", function: info.fn, installedVersion: inst, latestVersion: latest.version,
      status: !inst ? "incompatible" : latest.version && cmp(latest.version, inst) > 0 ? "update_available" : "installed",
      compatibility: latest.error ? `Dernière version non vérifiée : ${latest.error}` : "Vérifiée sur le registre npm", risks: info.risks, cost: "Gratuit (open source)",
      beneficiaryAgents: info.agents, permissions: [], verificationSource: "node_modules + registry.npmjs.org", verifiedAt: now,
      recommendation: latest.version && inst && cmp(latest.version, inst) > 0 ? "Mettre à jour après lecture du changelog et exécution des tests (aucune mise à jour automatique)." : null });
  }

  for (const t of TOOLS) {
    rows.push({ id: `tool:${t.name}`, name: t.name, kind: "internal_tool", provider: "LOÏC OS", function: t.description, installedVersion: "intégré", status: "installed",
      permissions: [`niveau ${t.level}`], beneficiaryAgents: AGENTS.filter((a) => a.tools.includes(t.name)).map((a) => a.id), risks: t.level >= 3 ? "Écrit des données (contrôlé par SENTINEL)" : "Lecture seule",
      cost: "0 $ (déterministe)", verificationSource: "Registre interne src/core/agents/tools.ts", verifiedAt: now });
  }

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  rows.push({ id: "anthropic:web_search_20260209", name: "Web search (outil serveur Anthropic)", kind: "anthropic_server_tool", provider: "Anthropic", installedVersion: hasKey ? "web_search_20260209" : null,
    function: "Recherche web avec sources, exécutée par l'API Claude", status: hasKey ? "installed" : "available", permissions: ["réseau externe (lecture)"],
    beneficiaryAgents: AGENTS.filter((a) => a.tools.includes("web_search")).map((a) => a.id), risks: "Contenu web non fiable (encapsulé comme donnée)",
    cost: "Facturé à l'usage par Anthropic en plus des tokens (voir la tarification officielle)", compatibility: "Sonnet 5.5 / Opus 5.5 (registre) ; nécessite ANTHROPIC_API_KEY",
    recommendation: hasKey ? null : "Indispensable pour ATHENA (veille stages, recherche d'entreprises). Requiert une clé API.", verificationSource: "Documentation Claude API (référence intégrée, 2026-11-03)", verifiedAt: now });

  // Intégrations candidates : listées seulement si le paquet officiel existe réellement.
  const candidates: { pkg: string; name: string; fn: string; agents: string[]; perms: string[]; why: string; alt: string }[] = [
    { pkg: "googleapis", name: "Google APIs (Gmail, Calendar, Drive)", fn: "Client officiel Google : brouillons/envoi Gmail, agenda, fichiers Drive", agents: ["flow", "dealmaker", "wordsmith", "scholar"],
      perms: ["OAuth 2.0", "gmail.compose", "calendar.events", "drive.readonly"], why: "Priorités 3 à 5 du cahier des charges (Gmail, Calendar, Drive).", alt: "Connecteurs MCP Google (à vérifier au cas par cas)" },
    { pkg: "@notionhq/client", name: "Notion API", fn: "Client officiel Notion", agents: ["scholar", "flow"], perms: ["OAuth / jeton d'intégration"], why: "Utile seulement si vos notes vivent dans Notion.", alt: "Import Markdown dans le Knowledge Vault" },
    { pkg: "voyageai", name: "Voyage AI (embeddings)", fn: "Embeddings pour la recherche vectorielle pgvector", agents: ["scholar", "atlas"], perms: ["clé API"], why: "Active la composante vectorielle de la recherche hybride (actuellement plein texte + trigrammes).", alt: "Rester en plein texte (gratuit)" },
    { pkg: "exceljs", name: "ExcelJS", fn: "Lecture des fichiers XLSX pour le Knowledge Vault", agents: ["scholar", "capital"], perms: ["aucune (local)"], why: "L'extraction XLSX n'est pas encore implémentée.", alt: "Exporter en CSV (déjà pris en charge)" },
  ];
  for (const c of candidates) {
    const latest = await registryLatest(c.pkg);
    if (!latest.version && latest.error === "absent du registre npm") continue; // jamais de plugin inventé
    const inst = await installedVersion(c.pkg);
    rows.push({ id: `npm:${c.pkg}`, name: c.name, kind: "integration", provider: c.pkg, function: c.fn, installedVersion: inst, latestVersion: latest.version,
      status: inst ? "installed" : "recommended", permissions: c.perms, beneficiaryAgents: c.agents, alternatives: c.alt, cost: "Paquet gratuit ; coûts éventuels du service tiers",
      risks: "Code tiers : revue, épinglage de version et tests requis avant installation", recommendation: c.why,
      compatibility: latest.version ? `Paquet ${c.pkg}@${latest.version} vérifié sur npm` : `Existence non vérifiée (${latest.error})`, verificationSource: "registry.npmjs.org", verifiedAt: latest.version ? now : null });
  }

  await db.transaction(async (tx) => {
    for (const r of rows) await tx.insert(schema.pluginDefinitions).values(r).onConflictDoUpdate({ target: schema.pluginDefinitions.id, set: { ...r, updatedAt: now } });
    await audit(tx, { ownerId, actor: "agent:plugin_architect", action: "plugins.audit", details: { count: rows.length } });
  });
  return { count: rows.length, updates: rows.filter((r) => r.status === "update_available").length, recommended: rows.filter((r) => r.status === "recommended").length };
}
