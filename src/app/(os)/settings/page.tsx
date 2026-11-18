import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { audit } from "@/core/security/audit";
import { upsertFood } from "@/core/nutrition/service";
import { hashPassword, verifyCredentials } from "@/core/auth/session";
import { verifyModelAvailability } from "@/core/orchestration/llm";
import { Badge, Card, PageHeader, statusTone } from "@/components/ui";

async function setPref(ownerId: string, key: string, scope: string, value: unknown) {
  await db.insert(schema.userPreferences).values({ ownerId, key, scope, value, source: "user" })
    .onConflictDoUpdate({ target: [schema.userPreferences.ownerId, schema.userPreferences.key], set: { value, updatedAt: new Date(), source: "user" } });
  await audit(db, { ownerId, actor: "user", action: "preference.set", entityId: key, details: { value } });
}
async function saveAi(f: FormData) {
  "use server"; const u = await requireUser();
  const v = z.object({ mode: z.enum(["ECO", "BALANCED", "MAX_PERFORMANCE"]), mission: z.coerce.number().min(0).max(50), day: z.coerce.number().min(0).max(200), month: z.coerce.number().min(0).max(2000) }).parse(Object.fromEntries(f));
  await setPref(u.id, "ai.optimization_mode", "ai", v.mode); await setPref(u.id, "budget.mission_usd", "budget", v.mission);
  await setPref(u.id, "budget.day_usd", "budget", v.day); await setPref(u.id, "budget.month_usd", "budget", v.month);
  revalidatePath("/settings");
}
async function saveSecurity(f: FormData) { "use server"; const u = await requireUser(); await setPref(u.id, "security.auto_approve_internal", "security", f.get("auto") === "on"); revalidatePath("/settings"); }
async function addFood(f: FormData) {
  "use server"; const u = await requireUser();
  const v = z.object({ name: z.string().min(2), kcal: z.coerce.number(), p: z.coerce.number(), c: z.coerce.number(), l: z.coerce.number(), aliases: z.string().optional() }).parse(Object.fromEntries(f));
  await upsertFood(u.id, { name: v.name, kcal100g: v.kcal, protein100g: v.p, carbs100g: v.c, fat100g: v.l, dataStatus: "verified", sourceNote: "Étiquette saisie par l'utilisateur", aliases: (v.aliases ?? "").split(",").map((s) => s.trim()).filter(Boolean) });
  revalidatePath("/settings");
}
async function changePassword(f: FormData) {
  "use server"; const u = await requireUser();
  const cur = String(f.get("current")); const next = String(f.get("next"));
  if (next.length < 12) throw new Error("12 caractères minimum");
  if (!(await verifyCredentials(u.email, cur))) throw new Error("Mot de passe actuel incorrect");
  await db.update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, u.id));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
  await audit(db, { ownerId: u.id, actor: "user", action: "auth.password_changed" });
}
async function checkModels() { "use server"; await requireUser(); await verifyModelAvailability(); revalidatePath("/settings"); }

export default async function SettingsPage() {
  const user = await requireUser();
  const prefs = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.ownerId, user.id));
  const p = (k: string) => prefs.find((x) => x.key === k)?.value;
  const foods = await db.select().from(schema.foods).where(eq(schema.foods.ownerId, user.id));
  const conns = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.ownerId, user.id));
  const procedural = await db.select().from(schema.memories).where(and(eq(schema.memories.ownerId, user.id), eq(schema.memories.type, "procedural"), eq(schema.memories.status, "active")));
  return (
    <>
      <PageHeader title="Settings" subtitle="Préférences, budgets IA, sécurité, nutrition, intégrations et données." />
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="TOKEN MASTER & budgets">
          <form action={saveAi} className="space-y-3 text-[13px]">
            <label className="block"><span className="text-muted text-[12px]">Mode d&apos;optimisation</span>
              <select name="mode" defaultValue={String(p("ai.optimization_mode") ?? "BALANCED")} className="input mt-1" data-testid="mode-select"><option value="ECO">ECO — priorité au coût</option><option value="BALANCED">BALANCED — équilibre (défaut)</option><option value="MAX_PERFORMANCE">MAX PERFORMANCE — priorité à la qualité</option></select></label>
            <div className="grid grid-cols-3 gap-2">
              <label><span className="text-muted text-[12px]">Par mission ($)</span><input name="mission" type="number" step="0.01" defaultValue={Number(p("budget.mission_usd") ?? 0.5)} className="input mt-1" /></label>
              <label><span className="text-muted text-[12px]">Par jour ($)</span><input name="day" type="number" step="0.1" defaultValue={Number(p("budget.day_usd") ?? 2)} className="input mt-1" /></label>
              <label><span className="text-muted text-[12px]">Par mois ($)</span><input name="month" type="number" step="1" defaultValue={Number(p("budget.month_usd") ?? 20)} className="input mt-1" /></label>
            </div>
            <button className="btn btn-primary" data-testid="save-ai">Enregistrer</button>
          </form>
          <form action={checkModels} className="mt-3"><button className="btn text-[12px]" disabled={!process.env.ANTHROPIC_API_KEY}>Vérifier la disponibilité des modèles (GET /v1/models)</button></form>
          <p className="text-[11px] text-faint mt-2">Facturation API Anthropic ≠ abonnement Claude ≠ usage Claude Code : la clé de LOÏC OS est facturée à part, à l&apos;usage. Coûts d&apos;hébergement et d&apos;intégrations tierces non inclus.</p>
        </Card>
        <Card title="Sécurité">
          <form action={saveSecurity} className="space-y-2 text-[13px]">
            <label className="flex gap-2 items-center"><input type="checkbox" name="auto" defaultChecked={p("security.auto_approve_internal") !== false} /> Exécuter sans validation les modifications internes non destructives (niveau 3)</label>
            <p className="text-[12px] text-muted">Les actions externes (niveau 4) exigent toujours une approbation. Les transactions financières sont interdites.</p>
            <button className="btn">Enregistrer</button>
          </form>
          <form action={changePassword} className="mt-4 space-y-2"><div className="text-[12px] text-muted">Changer le mot de passe (déconnecte toutes les sessions)</div>
            <input type="password" name="current" className="input" placeholder="Actuel" required autoComplete="current-password" /><input type="password" name="next" className="input" placeholder="Nouveau (12+ caractères)" required autoComplete="new-password" /><button className="btn">Modifier</button></form>
        </Card>
        <Card title="Préférences de communication (mémoire procédurale)">
          <ul className="space-y-1 text-[13px]">{procedural.map((m) => <li key={m.id}>• {m.content} <span className="text-faint text-[11px]">({m.category})</span></li>)}</ul>
          <a className="text-accent text-[12px] mt-2 inline-block" href="/memory?category=communication">Modifier dans Memory →</a>
        </Card>
        <Card title="Intégrations">
          {conns.map((c) => <div key={c.id} className="flex items-center gap-2 border-t border-line py-1.5 text-[13px]"><Badge tone={statusTone(c.status)}>{c.status}</Badge><span>{c.provider}</span>
            <span className="text-faint text-[12px] ml-auto">{c.provider === "web_search" ? (process.env.ANTHROPIC_API_KEY ? "via outil serveur Anthropic" : "requiert ANTHROPIC_API_KEY") : "OAuth non implémenté (GOOGLE_CLIENT_ID requis)"}</span></div>)}
          <p className="text-[11px] text-faint mt-2">Les jetons OAuth seront chiffrés en AES-256-GCM (module prêt : src/core/security/crypto.ts).</p>
        </Card>
        <Card title={`Nutrition — base d'aliments (${foods.length})`} className="lg:col-span-2">
          <form action={addFood} className="flex flex-wrap gap-2 mb-3 text-[13px]">
            <input name="name" className="input w-48" placeholder="Nom (ex. Fromage blanc 0 % Marque X)" required /><input name="kcal" type="number" step="0.1" className="input w-24" placeholder="kcal" required />
            <input name="p" type="number" step="0.1" className="input w-24" placeholder="Prot." required /><input name="c" type="number" step="0.1" className="input w-24" placeholder="Gluc." required /><input name="l" type="number" step="0.1" className="input w-24" placeholder="Lip." required />
            <input name="aliases" className="input w-48" placeholder="alias, séparés" /><button className="btn">Ajouter (valeurs vérifiées)</button>
          </form>
          <table className="w-full text-[12.5px]"><thead className="text-muted text-left"><tr><th>Aliment (pour 100 g)</th><th>kcal</th><th>P</th><th>G</th><th>L</th><th>Statut</th></tr></thead>
            <tbody>{foods.map((f) => <tr key={f.id} className="border-t border-line"><td className="py-1">{f.name} <span className="text-faint">{f.aliases.join(", ")}</span></td><td>{f.kcal100g}</td><td>{f.protein100g}</td><td>{f.carbs100g}</td><td>{f.fat100g}</td><td><Badge tone={f.dataStatus === "verified" ? "ok" : "warn"} title={f.sourceNote}>{f.dataStatus}</Badge></td></tr>)}</tbody></table>
        </Card>
        <Card title="Données">
          <div className="flex gap-2 flex-wrap"><a className="btn" href="/api/export" data-testid="export">Exporter toutes mes données (JSON)</a></div>
          <p className="text-[12px] text-muted mt-2">Sauvegarde / restauration de la base : <code>pnpm backup</code> et <code>scripts/restore.sh</code> (voir README).</p>
        </Card>
      </div>
    </>
  );
}
