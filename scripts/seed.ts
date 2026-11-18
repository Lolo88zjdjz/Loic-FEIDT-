/**
 * Initialisation de LOÏC OS à partir du profil personnel fourni (données
 * HISTORIQUES issues de conversations 2025-2026). Règles appliquées :
 *  - chaque fait est daté (observed_at) quand la date est connue ; sinon la
 *    date d'import est utilisée et le tag `date_inconnue` est posé ;
 *  - statut de confiance « imported_historical » (jamais une probabilité) ;
 *  - aucune donnée déduite non indiquée ; les relations déduites sont
 *    marquées « inferred » avec leur justification ;
 *  - santé = catégorie « health », sensibilité « sensitive ».
 * Idempotent : si le propriétaire existe déjà, seules les données de
 * registre (agents, modèles, automatisations) sont resynchronisées.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, schema, pool } from "../src/core/db/client";
import { hashPassword } from "../src/core/auth/session";
import { createMemory, type MemoryInput } from "../src/core/memory/service";
import { createProject, createTask, createEvent } from "../src/core/projects/service";
import { upsertOrganization, createContact, createOpportunity, logInteraction } from "../src/core/crm/service";
import { emit } from "../src/core/graph/sync";
import { findEntityNode, link, upsertEntityNode } from "../src/core/graph/service";
import { upsertFood } from "../src/core/nutrition/service";
import { syncRegistries } from "../src/core/registry-sync";
import { runPluginAudit } from "../src/core/plugins/audit";

const IMPORT_DATE = "2026-11-18";
const email = (process.env.LOIC_OS_OWNER_EMAIL ?? "loic@localhost").toLowerCase();
const password = process.env.LOIC_OS_OWNER_PASSWORD;
if (!password || password.length < 10) throw new Error("LOIC_OS_OWNER_PASSWORD (≥ 10 caractères) requis dans .env");

let [owner] = await db.select().from(schema.users).where(eq(schema.users.email, email));
if (owner) {
  console.log("Propriétaire déjà présent : resynchronisation des registres uniquement.");
  await syncRegistries(owner.id);
  await runPluginAudit(owner.id).catch((e) => console.warn("Audit plugins :", e.message));
  await pool.end();
  process.exit(0);
}
[owner] = await db.insert(schema.users).values({ email, passwordHash: await hashPassword(password), displayName: "Loïc" }).returning();
const O = owner.id;
const [src] = await db.insert(schema.sources).values({ ownerId: O, kind: "seed", title: "Profil initial fourni par Loïc (conversations 2025-2026)", retrievedAt: new Date(IMPORT_DATE),
  metadata: { note: "Données historiques : à actualiser avant usage décisionnel." } }).returning();
const S = src.id;

// ── Préférences ───────────────────────────────────────────────────
const prefs: [string, string, unknown, string][] = [
  ["ai.optimization_mode", "ai", "BALANCED", "Mode TOKEN MASTER : ECO | BALANCED | MAX_PERFORMANCE"],
  ["budget.mission_usd", "budget", 0.5, "Plafond par mission (USD)"],
  ["budget.day_usd", "budget", 2, "Plafond journalier (USD)"],
  ["budget.month_usd", "budget", 20, "Plafond mensuel (USD)"],
  ["security.auto_approve_internal", "security", true, "Exécuter sans validation les modifications internes non destructives (niveau 3)"],
  ["ui.theme", "ui", "dark", "Thème de l'interface"],
  ["communication.language", "communication", "fr", "Langue principale"],
];
for (const [key, scope, value, description] of prefs) await db.insert(schema.userPreferences).values({ ownerId: O, key, scope, value, description, source: "seed" });

// ── Projets ───────────────────────────────────────────────────────
const P: Record<string, string> = {};
const projectDefs = [
  { key: "stage", name: "Recherche de stage 2027", area: "career", description: "Premier stage de L3 : 4 à 5 mois, début printemps 2027, Paris en priorité, ouverture à l'international.", startsOn: null, endsOn: null },
  { key: "altigliss", name: "Altigliss 2026-2027", area: "partnerships", description: "Responsable partenariats (équipements, automobile, luxe) pour le GEM Altigliss Challenge à La Plagne.", startsOn: null, endsOn: null },
  { key: "gem", name: "GEM — Études", area: "academic", description: "Programme Grande École, niveau L3 en 2026-2027. Intérêt pour le parcours géopolitique / Geolab.", startsOn: null, endsOn: null },
  { key: "sport", name: "Performance sportive", area: "sport", description: "Ski, handball, musculation, course et trail.", startsOn: null, endsOn: null },
  { key: "nutrition", name: "Nutrition", area: "nutrition", description: "Journal alimentaire, macros, repas simples, budget.", startsOn: null, endsOn: null },
  { key: "thailande", name: "Thaïlande 2027", area: "travel", description: "Voyage à deux du 6 au 29 janvier 2027. Aucune réservation confirmée enregistrée.", startsOn: "2027-01-06", endsOn: "2027-01-29" },
  { key: "growth", name: "Développement personnel et professionnel", area: "growth", description: "Compétences, ambitions, opportunités, formation, expériences.", startsOn: null, endsOn: null },
] as const;
for (const p of projectDefs) P[p.key] = (await createProject(O, { name: p.name, area: p.area, description: p.description, startsOn: p.startsOn, endsOn: p.endsOn }, "seed")).id;

// ── Mémoire ───────────────────────────────────────────────────────
type M = Omit<MemoryInput, "confidenceStatus" | "sourceId"> & { undated?: boolean };
const mem = async (m: M) => createMemory(O, { ...m, sourceId: S, confidenceStatus: "imported_historical", observedAt: m.observedAt ?? IMPORT_DATE,
  tags: [...(m.tags ?? []), ...(m.undated || !m.observedAt ? ["date_inconnue"] : [])] }, "seed");

const memories: M[] = [
  // Identité
  { content: "Prénom : Loïc.", type: "identity", category: "identity" },
  { content: "Loïc a 21 ans en 2026.", type: "identity", category: "identity", observedAt: "2026-01-01", tags: ["date_approx"] },
  { content: "Originaire d'Alsace (région de Colmar, secteur des Vosges).", type: "identity", category: "identity" },
  { content: "Résidence étudiante à Grenoble.", type: "identity", category: "identity" },
  { content: "Langue principale : français. Langues étudiées : anglais et allemand.", type: "identity", category: "identity" },
  { content: "Centres d'intérêt : sport, ski, montagne, handball, course à pied, musculation, voyages, business, développement commercial, stratégie d'entreprise, marques premium, géopolitique, innovation, intelligence artificielle, productivité.", type: "identity", category: "interests" },
  // Communication (procédural)
  { content: "Préfère des réponses naturelles, directes, concrètes, précises, structurées et adaptées à la demande.", type: "procedural", category: "communication" },
  { content: "Questions simples : réponses courtes. Projets importants : analyse poussée. Travaux académiques : explications rigoureuses.", type: "procedural", category: "communication" },
  { content: "E-mails professionnels : ton crédible, humain, fluide, pas excessivement commercial.", type: "procedural", category: "communication" },
  { content: "Exercices de finance : rédaction concise avec le développement essentiel, comme dans un partiel.", type: "procedural", category: "communication", tags: ["finance"] },
  { content: "Utilise Excel en français (noms de fonctions en français).", type: "procedural", category: "communication", tags: ["excel"] },
  // Études
  { content: "Baccalauréat au lycée Camille Sée à Colmar.", type: "episodic", category: "education" },
  { content: "Classe préparatoire ECG au lycée Kléber à Strasbourg.", type: "episodic", category: "education" },
  { content: "A passé les concours des grandes écoles de commerce en 2025.", type: "episodic", category: "education", observedAt: "2025-06-01", tags: ["date_approx"] },
  { content: "Étudiant au Programme Grande École de Grenoble École de Management (GEM).", type: "semantic", category: "education", projectId: "gem" },
  { content: "En 2026-2027 : niveau L3 à GEM.", type: "semantic", category: "education", projectId: "gem", validFrom: "2026-09-01", validUntil: "2027-08-31" },
  { content: "Intérêt pour le parcours géopolitique / Geolab à GEM (piste, pas une décision).", type: "semantic", category: "education", projectId: "gem", observedAt: "2026-09-01", tags: ["piste", "date_approx"] },
  { content: "Matières étudiées : comptabilité, analyse financière, finance d'entreprise, marketing, droit, statistiques, Excel, gestion de projet, ressources humaines, stratégie, géopolitique.", type: "semantic", category: "education", projectId: "gem" },
  // Carrière
  { content: "Anciennes pistes professionnelles : finance de marché, gestion d'actifs, événementiel sportif.", type: "semantic", category: "career", tags: ["obsolète_possible"] },
  { content: "Intérêts professionnels exprimés à l'automne 2026 : sales, wholesale, business development, e-commerce, retail, operations, product development, stratégie d'entreprise, développement de marques, partenariats, sponsoring, fonctions commerciales et stratégiques.", type: "semantic", category: "career", projectId: "stage", observedAt: "2026-10-01", tags: ["date_approx"] },
  { content: "Secteurs d'intérêt : sport, outdoor, luxe, marques premium, biens de consommation, entreprises internationales — reste ouvert à d'autres environnements enrichissants.", type: "semantic", category: "career", projectId: "stage", observedAt: "2026-10-01", tags: ["date_approx"] },
  { content: "Recherche un premier stage de L3 de 4 à 5 mois, début printemps 2027, de préférence à Paris, ouvert à l'international.", type: "project", category: "career", projectId: "stage", observedAt: "2026-10-01", tags: ["date_approx"] },
  { content: "Objectifs du stage : découvrir les métiers, développer des compétences, construire un réseau, obtenir une expérience valorisante, préparer l'orientation future.", type: "project", category: "career", projectId: "stage" },
  { content: "Envisage des parcours complémentaires, des échanges internationaux et une poursuite d'études possiblement tournée vers la géopolitique ou les relations internationales (pistes non décidées).", type: "semantic", category: "career", projectId: "growth", tags: ["piste"] },
  // Altigliss
  { content: "Membre d'Altigliss, l'association de ski de GEM.", type: "semantic", category: "partnerships", projectId: "altigliss" },
  { content: "En 2026-2027, responsable de partenariats dans les catégories équipements, automobile et luxe chez Altigliss.", type: "semantic", category: "partnerships", projectId: "altigliss", validFrom: "2026-09-01", validUntil: "2027-08-31", observedAt: "2026-09-01", tags: ["date_approx"] },
  { content: "Altigliss organise le GEM Altigliss Challenge à La Plagne : environ 1 000 étudiants (ordre de grandeur historique), compétitions, animations, concerts, village partenaires, activations de marques, dotations.", type: "semantic", category: "partnerships", projectId: "altigliss" },
  { content: "Responsabilités partenariats : recherche de partenaires, prospection, négociation, gestion des relations, analyse des propositions, suivi de dossiers, organisation de dotations, valorisation des contreparties.", type: "semantic", category: "partnerships", projectId: "altigliss" },
  { content: "Peak Performance : une demande de réduction de 60 % n'a pas été acceptée sur certains produits ; la relation avec Cyril Duret doit être préservée.", type: "episodic", category: "partnerships", projectId: "altigliss" },
  { content: "Peak Performance : une perspective de contact professionnel pour la recherche de stage a été envisagée (piste de networking, pas une offre).", type: "episodic", category: "career", projectId: "stage", tags: ["piste"] },
  { content: "Haglöfs — proposition historique d'octobre 2026 (HT) : veste ALPER 3L 114 €, polaire BUTÉO 28 €, doudoune Maroon/Anima 145 €, t-shirt 19,50 €, hoodie 47,50 €. Prix à reconfirmer avant tout usage.", type: "episodic", category: "partnerships", projectId: "altigliss", observedAt: "2026-10-01", validUntil: null, tags: ["prix_historiques", "à_vérifier"] },
  { content: "Picture — offre historique : 40 % de réduction sur des produits du catalogue hiver. À reconfirmer.", type: "episodic", category: "partnerships", projectId: "altigliss", tags: ["à_vérifier"] },
  { content: "Pierre Lannier — projet de dotation de 12 montres pour les équipes gagnantes (répartition hommes/femmes, valeur indicative ~200 € par montre). Contreparties discutées : réseaux sociaux, écrans géants, présence sur le site, remise des prix, contenus photo/vidéo, jeu concours.", type: "episodic", category: "partnerships", projectId: "altigliss" },
  { content: "Préférence logistique (dotations) : éviter autant que possible la collecte complexe des coordonnées des participants ; solution envisagée : bons/vouchers remis directement aux gagnants.", type: "procedural", category: "partnerships", projectId: "altigliss" },
  // Sport
  { content: "Environ sept années de ski en club, dont trois en compétition.", type: "episodic", category: "sport", projectId: "sport" },
  { content: "Handball : environ un match et un entraînement par semaine ; a encadré une équipe féminine étudiante à GEM.", type: "semantic", category: "sport", projectId: "sport" },
  { content: "Musculation : 2 à 4 séances par semaine selon les périodes ; intérêt pour le haut du corps (épaules, pectoraux, dos), possibilité d'intégrer davantage de jambes.", type: "semantic", category: "sport", projectId: "sport" },
  { content: "Course : intérêt pour le trail, sorties avec dénivelé, objectif de progression cardio.", type: "semantic", category: "sport", projectId: "sport" },
  { content: "Objectifs corporels historiques : améliorer la composition corporelle, préserver ou développer la masse musculaire, réduire la masse grasse, améliorer les performances.", type: "project", category: "sport", projectId: "sport", tags: ["historique"] },
  { content: "Antécédent d'entorse de la cheville gauche avec instabilité rapportée. À actualiser avant tout conseil ; aucun diagnostic.", type: "semantic", category: "health", sensitivity: "sensitive", projectId: "sport", tags: ["à_actualiser"] },
  // Nutrition
  { content: "Objectif historique : environ 150 g de protéines par jour, gestion du poids, maintien musculaire, budget alimentaire raisonnable.", type: "project", category: "nutrition", projectId: "nutrition", sensitivity: "private", tags: ["historique"] },
  { content: "Aliments appréciés : poulet, dinde, steak haché 5 %, œufs, thon, saumon, poisson blanc, riz, pâtes, semoule, pommes de terre, wraps, haricots verts, brocolis, petits pois, fromage blanc, fromage râpé, sauces simples, épices douces.", type: "procedural", category: "nutrition", projectId: "nutrition" },
  { content: "Préférences repas : faciles, préparation simple, riches en protéines, réchauffables au micro-ondes ; budget historique 3 à 5 € par portion.", type: "procedural", category: "nutrition", projectId: "nutrition" },
  // Voyage
  { content: "Voyage en Thaïlande prévu à deux voyageurs du 6 au 29 janvier 2027 ; arrivée envisagée le 7 janvier.", type: "project", category: "travel", projectId: "thailande" },
  { content: "Budget cible historique Thaïlande : environ 2 500 € par personne, vols inclus.", type: "project", category: "travel", projectId: "thailande", tags: ["historique"] },
  { content: "Destinations envisagées : Bangkok, Chiang Mai, îles du sud. Éviter Phuket dans l'itinéraire principal ; limiter les transferts trop longs ; mixer confort et aventure.", type: "procedural", category: "travel", projectId: "thailande" },
  { content: "Expériences recherchées en Thaïlande : snorkeling, plongée, plages, kayak, excursions en bateau, couchers de soleil, temples, jungle, cascades, Muay Thai, découverte culinaire, Full Moon Party.", type: "semantic", category: "travel", projectId: "thailande" },
  { content: "Aucune réservation de voyage n'est confirmée à ce jour dans LOÏC OS.", type: "semantic", category: "travel", projectId: "thailande", observedAt: IMPORT_DATE },
];
const memIds: Record<string, string> = {};
for (const m of memories) {
  const created = await mem({ ...m, projectId: m.projectId ? P[m.projectId as string] : null });
  memIds[m.content.slice(0, 30)] = created.id;
}

// ── CRM ───────────────────────────────────────────────────────────
const org = async (name: string, kind: "brand" | "school" | "association" | "company", sector: string | null, notes: string | null) => (await upsertOrganization(O, { name, kind, sector, notes }, "seed")).org.id;
const altigliss = await org("Altigliss", "association", "Association étudiante (ski)", "Association de ski de GEM, organisatrice du GEM Altigliss Challenge à La Plagne.");
const gem = await org("Grenoble École de Management", "school", "Enseignement supérieur", "École de Loïc (PGE).");
await org("Lycée Kléber", "school", "Enseignement", "Classe préparatoire ECG (Strasbourg).");
await org("Lycée Camille Sée", "school", "Enseignement", "Baccalauréat (Colmar).");
const peak = await org("Peak Performance", "brand", "Outdoor / textile", "Discussions : équipement du staff Altigliss (vestes, polaires, t-shirts, hoodies), remises, conditions.");
const haglofs = await org("Haglöfs", "brand", "Outdoor / textile", null);
const picture = await org("Picture", "brand", "Outdoor / textile", null);
const lannier = await org("Pierre Lannier", "brand", "Horlogerie", null);
const prospects = ["Garmin", "COROS", "Withings", "Alpina", "Herbelin", "Sun Valley", "Julbo", "The North Face", "Mammut", "Rab", "Ekosport", "BUFF", "DAKINE", "Alpine", "Bollé", "Petzl", "Thule", "Cimalp", "Mavic", "Zéfal", "Ice Mountain", "PlayStation"];
const prospectIds: Record<string, string> = {};
for (const p of prospects) prospectIds[p] = await org(p, "brand", null, "Contact, prospect ou entreprise envisagée (liste historique) — statut à confirmer.");

const cyril = await createContact(O, { fullName: "Cyril Duret", organizationId: peak, role: null, notes: "Contact historique Peak Performance. Coordonnées non enregistrées." }, "seed");

const opp = async (organizationId: string, title: string, stage: string, valueNote: string | null, nextAction: string | null) =>
  (await createOpportunity(O, { organizationId, projectId: P.altigliss, pipeline: "partnership", title, stage, valueNote, nextAction }, "seed")).id;
const oPeak = await opp(peak, "Équipement du staff Altigliss", "negotiating", "Vestes, polaires, t-shirts, hoodies ; remise de 60 % refusée sur certains produits.", "Proposer une contre-offre réaliste en préservant la relation");
const oHag = await opp(haglofs, "Proposition équipement (oct. 2026)", "replied", "Prix HT historiques : ALPER 3L 114 €, BUTÉO 28 €, Maroon/Anima 145 €, t-shirt 19,50 €, hoodie 47,50 € — à reconfirmer.", "Reconfirmer la validité des prix");
const oPic = await opp(picture, "Remise catalogue hiver", "replied", "40 % de réduction (offre historique, à reconfirmer).", null);
const oLan = await opp(lannier, "Dotation 12 montres équipes gagnantes", "negotiating", "~200 € par montre (indicatif) ; contreparties : réseaux sociaux, écrans géants, site, remise des prix, photo/vidéo, jeu concours.", "Valider la solution de vouchers remis aux gagnants");
for (const p of prospects) await createOpportunity(O, { organizationId: prospectIds[p], projectId: P.altigliss, pipeline: "partnership", title: `Partenariat Altigliss — ${p}`, stage: "identified" }, "seed");

await logInteraction(O, { organizationId: peak, contactId: cyril.id, opportunityId: oPeak, channel: "email", direction: "outbound", summary: "Demande de réduction de 60 % sur l'équipement staff, non acceptée sur certains produits.", occurredOn: null, datePrecision: "unknown" }, "seed");
await logInteraction(O, { organizationId: haglofs, opportunityId: oHag, channel: "email", direction: "inbound", summary: "Proposition chiffrée (ALPER 3L, BUTÉO, Maroon/Anima, t-shirt, hoodie).", occurredOn: "2026-10-01", datePrecision: "month" }, "seed");
await logInteraction(O, { organizationId: picture, opportunityId: oPic, channel: "email", direction: "inbound", summary: "Offre de 40 % sur des produits du catalogue hiver.", occurredOn: null, datePrecision: "unknown" }, "seed");
await logInteraction(O, { organizationId: lannier, opportunityId: oLan, channel: "email", direction: "outbound", summary: "Échanges sur la dotation de 12 montres, la répartition H/F et les contreparties de visibilité ; piste des vouchers.", occurredOn: null, datePrecision: "unknown" }, "seed");

// ── Objectifs, événements, tâches ────────────────────────────────
const goal = async (title: string, projectKey: string, horizon: string, description: string, observedAt: string | null) => {
  const [g] = await db.insert(schema.goals).values({ ownerId: O, projectId: P[projectKey], title, horizon, description, observedAt }).returning();
  await db.transaction((tx) => emit(tx, O, "seed", { type: "goal.upserted", id: g.id }));
  return g.id;
};
const gStage = await goal("Décrocher un stage L3 (printemps 2027)", "stage", "court terme", "4–5 mois, Paris prioritaire, fonctions commerciales / stratégiques.", "2026-10-01");
await goal("Environ 150 g de protéines par jour", "nutrition", "continu", "Objectif historique.", null);
await goal("Améliorer la composition corporelle et les performances", "sport", "moyen terme", "Objectif historique.", null);
await goal("Voyage Thaïlande mémorable à ~2 500 €/personne", "thailande", "court terme", "Budget cible historique, vols inclus.", null);
await goal("Explorer la géopolitique / relations internationales", "growth", "long terme", "Piste non décidée (Geolab, échanges, poursuite d'études).", null);

await createEvent(O, { title: "Voyage Thaïlande (non réservé)", startsAt: new Date("2027-01-06T00:00:00+01:00"), endsAt: new Date("2027-01-29T23:59:00+07:00"), allDay: true, status: "tentative", projectId: P.thailande, notes: "Dates prévues ; aucune réservation confirmée." }, "seed");

const sugg = [
  ["Reconfirmer les prix de la proposition Haglöfs (oct. 2026)", "altigliss", 2],
  ["Préciser avec Pierre Lannier la solution de vouchers pour les gagnants", "altigliss", 2],
  ["Préparer une contre-proposition à Peak Performance en préservant la relation", "altigliss", 2],
  ["Mettre à jour le CV (expérience partenariats Altigliss)", "stage", 1],
  ["Lister 15 entreprises cibles pour le stage (Paris, sales / BD / marques)", "stage", 2],
  ["Importer les supports de cours du semestre dans le Knowledge Vault", "gem", 3],
  ["Vérifier les formalités d'entrée en Thaïlande et la validité du passeport", "thailande", 2],
] as const;
for (const [title, pk, prio] of sugg) await createTask(O, { title, projectId: P[pk], priority: prio, description: "Suggestion initiale générée à partir du profil (modifiable / supprimable)." }, "atlas:suggestion");

// ── Graphe : nœuds natifs et relations expliquées ────────────────
await db.transaction(async (tx) => {
  const node = (type: Parameters<typeof upsertEntityNode>[1]["type"], label: string, refId: string, description?: string, sensitivity: "public" | "personal" = "personal") =>
    upsertEntityNode(tx, { ownerId: O, type, label, refTable: "native", refId, description, sensitivity, sourceId: S, actor: "seed" });
  const L = (type: Parameters<typeof link>[1]["type"], a: string, b: string, provenance: string, validation: "confirmed" | "inferred" = "confirmed", confidenceNote?: string) =>
    link(tx, { ownerId: O, type, source: a, target: b, provenance, validation, confidenceNote, sourceId: S, actor: "seed" });
  const proj = async (k: string) => (await findEntityNode(tx, O, "projects", P[k]))!.id;
  const orgN = async (id: string) => (await findEntityNode(tx, O, "organizations", id))!.id;

  const me = await node("Person", "Loïc", "self", "Propriétaire de LOÏC OS");
  for (const k of Object.keys(P)) await L("WORKS_ON", me.id, await proj(k), "Projet initial du profil");
  await L("BELONGS_TO", me.id, await orgN(gem), "Étudiant PGE (profil)");
  await L("BELONGS_TO", me.id, await orgN(altigliss), "Membre d'Altigliss (profil)");
  await L("BELONGS_TO", await proj("altigliss"), await orgN(altigliss), "Projet mené pour l'association");
  await L("BELONGS_TO", await proj("gem"), await orgN(gem), "Études à GEM");
  await L("BELONGS_TO", await orgN(altigliss), await orgN(gem), "Association de ski de GEM");
  const cyrilN = (await findEntityNode(tx, O, "contacts", cyril.id))!.id;
  await L("KNOWS", me.id, cyrilN, "Contact historique dans le cadre des discussions Peak Performance");

  const challenge = await node("Event", "GEM Altigliss Challenge (La Plagne)", "altigliss-challenge", "≈1 000 étudiants (ordre de grandeur historique) ; date non enregistrée.");
  await L("BELONGS_TO", challenge.id, await proj("altigliss"), "Événement organisé par Altigliss");

  const skills = [
    ["Négociation B2B", "Négociations documentées avec Peak Performance, Haglöfs, Pierre Lannier"],
    ["Prospection commerciale", "Responsabilité déclarée : recherche de partenaires et prospection"],
    ["Gestion de partenariats", "Responsabilité déclarée : gestion des relations et suivi de dossiers"],
    ["Valorisation de contreparties", "Responsabilité déclarée : valorisation des contreparties"],
  ] as const;
  const skillIds: string[] = [];
  for (const [label, why] of skills) {
    const s = await node("Skill", label, `skill:${label}`, why);
    skillIds.push(s.id);
    await L("DERIVED_FROM", s.id, await proj("altigliss"), `Compétence issue de l'expérience Altigliss : ${why}`);
    await L("CONTRIBUTES_TO", s.id, (await findEntityNode(tx, O, "goals", gStage))!.id, "Compétence valorisable pour un stage en sales / business development", "inferred",
      "Hypothèse : correspond aux intérêts professionnels exprimés à l'automne 2026 ; non validée par un recruteur.");
  }
  await L("RELATED_TO", await orgN(peak), await proj("stage"), "Perspective de contact professionnel pour la recherche de stage envisagée (piste de networking)", "inferred",
    "Piste mentionnée dans le profil ; aucune offre ni candidature enregistrée.");
  await L("RELATED_TO", await proj("altigliss"), await proj("stage"), "L'expérience partenariats est un argument de candidature pour des fonctions commerciales", "inferred", "Hypothèse fondée sur les intérêts professionnels de l'automne 2026.");

  for (const t of ["Géopolitique", "Intelligence artificielle", "Marques premium", "Ski & montagne", "Stratégie d'entreprise"]) {
    const tn = await node("Topic", t, `topic:${t}`);
    await L("ASSOCIATED_WITH", me.id, tn.id, "Centre d'intérêt déclaré");
  }
  const geo = await node("Topic", "Géopolitique", "topic:Géopolitique");
  await L("RELATED_TO", geo.id, await proj("gem"), "Parcours géopolitique / Geolab envisagé (piste)", "inferred", "Intérêt déclaré, pas une décision.");
  await L("RELATED_TO", geo.id, await proj("growth"), "Poursuite d'études possiblement orientée géopolitique (piste)", "inferred", "Piste non décidée.");
  const src = await node("Source", "Profil initial (conversations 2025-2026)", `source:${S}`);
  await L("DERIVED_FROM", me.id, src.id, "Les informations du profil proviennent de cette source");
});

// ── Aliments (valeurs génériques ESTIMÉES) ────────────────────────
const NOTE = "Valeur générique approximative pour 100 g (non vérifiée) — remplacer par l'étiquette du produit";
const foods: [string, number, number, number, number, string[]][] = [
  ["Fromage blanc 0 %", 46, 7.4, 4, 0.1, ["fromage blanc", "fromage blanc 0%"]],
  ["Fromage blanc 3,2 %", 75, 7, 4, 3.2, ["fromage blanc entier"]],
  ["Blanc de poulet cuit", 150, 31, 0, 2.5, ["poulet", "blanc de poulet"]],
  ["Escalope de dinde cuite", 140, 29, 0, 2, ["dinde"]],
  ["Steak haché 5 % (cru)", 125, 21, 0, 5, ["steak haché", "steak haché 5%"]],
  ["Œuf entier", 140, 12.5, 0.7, 9.5, ["oeuf", "oeufs", "œuf", "œufs"]],
  ["Thon au naturel égoutté", 115, 26, 0, 1, ["thon"]],
  ["Saumon (cru)", 200, 20, 0, 13, ["saumon"]],
  ["Cabillaud cuit", 100, 22, 0, 1, ["poisson blanc", "cabillaud"]],
  ["Riz blanc cuit", 130, 2.7, 28, 0.3, ["riz"]],
  ["Pâtes cuites", 155, 5.5, 30, 0.9, ["pâtes", "pates"]],
  ["Semoule cuite", 112, 3.8, 23, 0.2, ["semoule"]],
  ["Pommes de terre cuites à l'eau", 80, 2, 17, 0.1, ["pommes de terre", "pomme de terre", "patates"]],
  ["Wrap (tortilla de blé)", 300, 8.5, 50, 7, ["wrap", "wraps", "tortilla"]],
  ["Haricots verts cuits", 30, 1.8, 4.5, 0.2, ["haricots verts"]],
  ["Brocoli cuit", 35, 2.8, 4, 0.4, ["brocoli", "brocolis"]],
  ["Petits pois cuits", 80, 5.4, 11, 0.4, ["petits pois"]],
  ["Fromage râpé (emmental)", 380, 28, 0.5, 29, ["fromage râpé", "emmental"]],
];
for (const [name, k, p, c, f, aliases] of foods) await upsertFood(O, { name, kcal100g: k, protein100g: p, carbs100g: c, fat100g: f, dataStatus: "estimated", sourceNote: NOTE, aliases });

// ── Intégrations (aucune connectée) ──────────────────────────────
for (const provider of ["gmail", "google_calendar", "google_drive", "notion", "github", "web_search"]) await db.insert(schema.integrationConnections).values({ ownerId: O, provider, status: "not_connected" });

await syncRegistries(O);
const audit = await runPluginAudit(O).catch((e) => ({ error: (e as Error).message }));
console.log("✓ Seed terminé :", { memories: memories.length, projects: Object.keys(P).length, organizations: 8 + prospects.length, plugins: audit });
void memIds;
await pool.end();
