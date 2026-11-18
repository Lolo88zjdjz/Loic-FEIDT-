/**
 * Tests de bout en bout (Playwright, navigateur réel) sur l'application lancée.
 * Prérequis : `pnpm build && pnpm start` (port 3000) et base seedée.
 * Variables : E2E_BASE_URL, LOIC_OS_OWNER_EMAIL, LOIC_OS_OWNER_PASSWORD (.env).
 */
import "dotenv/config";
import { createRequire } from "node:module";
// Playwright : dépendance locale si installée, sinon installation globale (NODE_PATH).
const { chromium } = createRequire(import.meta.url)("playwright");
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SCREENSHOTS ?? "./test-results";
mkdirSync(SHOTS, { recursive: true });
const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`✓ ${name}`); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log(`✗ ${name}\n   ${e.message.split("\n")[0]}`); await page.screenshot({ path: `${SHOTS}/fail-${results.length}.png` }).catch(() => {}); }
}
const expectText = async (text, timeout = 15000) => page.getByText(text, { exact: false }).locator("visible=true").first().waitFor({ timeout });
async function chat(text) {
  const before = await page.getByTestId("assistant-message").count();
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send").click();
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="assistant-message"]').length > n, before, { timeout: 30000 });
  return page.getByTestId("assistant-message").last().innerText();
}

await step("Accès refusé sans session (redirection /login)", async () => {
  await page.goto(BASE + "/memory"); if (!page.url().includes("/login")) throw new Error("pas de redirection");
});
await step("Mauvais mot de passe refusé", async () => {
  await page.fill('input[name=email]', process.env.LOIC_OS_OWNER_EMAIL); await page.fill('input[name=password]', "mauvais-mot-de-passe");
  await page.click('button[type=submit]'); await expectText("Identifiants invalides");
});
await step("1-2. Lancer l'application et se connecter", async () => {
  await page.fill('input[name=email]', process.env.LOIC_OS_OWNER_EMAIL); await page.fill('input[name=password]', process.env.LOIC_OS_OWNER_PASSWORD);
  await page.click('button[type=submit]'); await page.waitForURL(BASE + "/"); await expectText("Universal Capture");
  await page.waitForTimeout(1500); await page.screenshot({ path: `${SHOTS}/dashboard.png` });
});
await step("3. Consulter mes projets", async () => {
  await page.goto(BASE + "/projects"); await expectText("Recherche de stage 2027"); await expectText("Thaïlande 2027");
  if ((await page.getByTestId("project-card").count()) < 7) throw new Error("projets manquants");
});
await step("13. Créer une tâche", async () => {
  await page.getByTestId("task-title").fill("E2E — préparer le dossier sponsoring Julbo"); await page.getByTestId("task-save").click();
  await expectText("E2E — préparer le dossier sponsoring Julbo");
});
await step("4. Discuter avec ATLAS (point global)", async () => {
  await page.goto(BASE + "/command"); const r = await chat("ATLAS, fais-moi un point global.");
  if (!r.includes("Point global") || !r.includes("Altigliss")) throw new Error(r.slice(0, 200));
});
await step("5. Exécuter un agent (NUTRI) — calcul déterministe", async () => {
  const r = await chat("Ajoute 250 g de fromage blanc à mon journal.");
  if (!/115/.test(r) || !/estimées/.test(r)) throw new Error(r.slice(0, 200));
});
await step("Ask My Brain — dossier Peak Performance (sources, données historiques)", async () => {
  const r = await chat("Que sais-tu de mes discussions avec Peak Performance ?");
  if (!r.includes("Cyril Duret") || !r.includes("60 %")) throw new Error(r.slice(0, 300));
});
await step("20. Comprendre pourquoi un modèle a été choisi (étapes d'exécution)", async () => {
  await page.getByText("Étapes d'exécution").last().click(); await expectText("Aucun modèle IA nécessaire");
  await page.screenshot({ path: `${SHOTS}/command-center.png` });
});
await step("Scénario B — relance en brouillon, en attente de validation", async () => {
  const r = await chat("Prépare une relance pour Pierre Lannier");
  if (!r.includes("Brouillon") || !r.includes("Rien ne sera envoyé")) throw new Error(r.slice(0, 200));
  await page.getByTestId("approval").first().waitFor();
});
await step("18. Refuser une action sensible", async () => {
  await page.getByTestId("reject").first().click(); await expectText("Action refusée");
  await page.goto(BASE + "/activity"); await expectText("rejected");
});
await step("6. Enregistrer un souvenir", async () => {
  await page.goto(BASE + "/memory"); await page.getByTestId("memory-content").fill("E2E : entretien téléphonique prévu avec une marque outdoor.");
  await page.getByTestId("memory-save").click(); await expectText("E2E : entretien téléphonique prévu");
});
await step("8-9. Importer un document et l'interroger avec sources", async () => {
  await page.goto(BASE + "/vault");
  await page.getByTestId("vault-file").setInputFiles({ name: "cours-finance-e2e.md", mimeType: "text/markdown", buffer: Buffer.from("# Finance d'entreprise\n\nLe BFR (besoin en fonds de roulement) mesure le décalage entre encaissements et décaissements d'exploitation.\n\nLa VAN actualise les flux futurs.") });
  await page.getByTestId("vault-upload").click(); await page.getByTestId("vault-msg").waitFor();
  await page.goto(BASE + "/vault?q=fonds%20de%20roulement"); await page.getByTestId("vault-hit").first().waitFor();
  const t = await page.getByTestId("vault-hit").first().innerText(); if (!t.includes("passage")) throw new Error(t);
});
await step("10-12. Visualiser le graphe réel, cliquer un nœud, comprendre ses relations", async () => {
  await page.goto(BASE + "/brain"); await page.waitForFunction(() => window.__loicCy && window.__loicCy.nodes().length > 20, null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const pos = await page.evaluate(() => { const n = window.__loicCy.nodes().filter((x) => x.data("label") === "Altigliss 2026-2027")[0]; const p = n.renderedPosition(); const r = document.querySelector('[data-testid="brain-canvas"]').getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; });
  await page.mouse.click(pos.x, pos.y); await expectText("Relations ("); await expectText("Ouvrir la fiche");
  await page.screenshot({ path: `${SHOTS}/neural-brain.png` });
});
await step("Scénario E — connexions Altigliss ↔ stage", async () => {
  await page.goto(BASE + "/command"); const r = await chat("Montre-moi toutes les connexions entre Altigliss 2026-2027 et Recherche de stage 2027.");
  if (!r.includes("chemin")) throw new Error(r.slice(0, 200));
});
await step("14. Ajouter une entreprise au CRM", async () => {
  await page.goto(BASE + "/crm"); await page.getByTestId("org-name").fill("Salomon E2E"); await page.getByTestId("org-save").click(); await expectText("Salomon E2E");
});
await step("15. Consulter l'historique des agents", async () => {
  await page.goto(BASE + "/agents/nutri"); await expectText("Historique"); await expectText("completed");
  await page.goto(BASE + "/agents"); await expectText("tests routage");
});
await step("16. Voir les coûts réels", async () => { await page.goto(BASE + "/costs"); await expectText("Registre des modèles"); await expectText("claude-sonnet-5-5"); });
await step("17. Modifier des préférences (mode ECO)", async () => {
  await page.goto(BASE + "/settings"); await page.getByTestId("mode-select").selectOption("ECO"); await page.getByTestId("save-ai").click();
  await page.waitForTimeout(800); await page.reload(); if ((await page.getByTestId("mode-select").inputValue()) !== "ECO") throw new Error("non persisté");
  await page.getByTestId("mode-select").selectOption("BALANCED"); await page.getByTestId("save-ai").click(); await page.waitForTimeout(500);
});
await step("19. Plugins avec statut vérifié", async () => { await page.goto(BASE + "/plugins"); await expectText("googleapis"); if ((await page.getByTestId("plugin-row").count()) < 20) throw new Error("inventaire incomplet"); });
await step("21. Exporter mes données", async () => {
  await page.goto(BASE + "/settings"); const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export").click()]);
  const path = await dl.path(); const json = JSON.parse((await import("node:fs")).readFileSync(path, "utf8"));
  if (!json.memories?.length || JSON.stringify(json).includes("passwordHash")) throw new Error("export invalide");
});
await step("Automatisations & santé système", async () => {
  await page.goto(BASE + "/automations"); await expectText("Briefing quotidien"); await expectText("actif");
  await page.goto(BASE + "/health"); await expectText("PostgreSQL");
});
await step("Universal Capture", async () => {
  await page.goto(BASE + "/"); await page.getByTestId("capture-input").fill("Relancer Garmin avant vendredi"); await page.getByText("Capturer").click(); await expectText("verbe d'action");
});
await step("Responsive (mobile 390 px)", async () => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(BASE + "/"); await expectText("Universal Capture");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (overflow > 4) throw new Error(`débordement horizontal ${overflow}px`);
  await page.setViewportSize({ width: 1440, height: 900 });
});
await step("Aucune erreur JavaScript dans les pages", async () => { if (errors.length) throw new Error(errors.join(" | ")); });

await browser.close();
writeFileSync(`${SHOTS}/e2e-results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} étapes réussies`);
process.exit(failed.length ? 1 : 0);
