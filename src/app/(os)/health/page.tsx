import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/core/db/client";
import { integrityReport } from "@/core/graph/service";
import { budgetState } from "@/core/model-router/router";
import { aiStatus } from "@/core/llm/status";
import { Badge, Card, fmtDate, PageHeader, statusTone, usd } from "@/components/ui";

export default async function HealthPage() {
  const user = await requireUser();
  const t0 = Date.now();
  const pg = (await db.execute(sql`SELECT version() AS v, (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector, (SELECT extversion FROM pg_extension WHERE extname='pg_trgm') AS trgm, pg_database_size(current_database()) AS size`)).rows[0] as { v: string; vector: string | null; trgm: string | null; size: string };
  const dbMs = Date.now() - t0;
  const [hb] = await db.select().from(schema.userPreferences).where(and(eq(schema.userPreferences.ownerId, user.id), eq(schema.userPreferences.key, "system.worker_heartbeat")));
  const workerAlive = hb && Date.now() - new Date(String(hb.value)).getTime() < 90_000;
  const queue = (await db.execute(sql`SELECT state, count(*)::int AS n FROM pgboss.job GROUP BY state`).catch(() => ({ rows: [] }))).rows as { state: string; n: number }[];
  const integrations = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.ownerId, user.id));
  const errors = (await db.execute(sql`SELECT 'agent' AS k, objective AS label, error, created_at FROM agent_runs WHERE owner_id = ${user.id} AND status='failed' UNION ALL SELECT 'automation', a.name, r.error, r.started_at FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE a.owner_id = ${user.id} AND r.status='failed' ORDER BY 4 DESC LIMIT 10`)).rows as { k: string; label: string; error: string; created_at: string }[];
  const integ = await integrityReport(user.id);
  const budget = await budgetState(user.id);
  const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
  const backupDir = path.join(process.cwd(), "backups");
  const backups = await readdir(backupDir).then(async (f) => Promise.all(f.filter((x) => x.endsWith(".dump") || x.endsWith(".sql.gz")).map(async (x) => ({ name: x, mtime: (await stat(path.join(backupDir, x))).mtime })))).catch(() => []);
  backups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const ai = await aiStatus(user.id);
  const services = [
    { name: "PostgreSQL", ok: true, detail: `${pg.v.split(" ").slice(0, 2).join(" ")} · ${dbMs} ms · ${(Number(pg.size) / 1e6).toFixed(1)} Mo` },
    { name: "pgvector", ok: !!pg.vector, detail: pg.vector ? `v${pg.vector} (colonnes prêtes ; embeddings non configurés)` : "absent" },
    { name: "pg_trgm", ok: !!pg.trgm, detail: pg.trgm ? `v${pg.trgm}` : "absent" },
    { name: "Worker (pg-boss)", ok: !!workerAlive, detail: hb ? `dernier signal ${fmtDate(String(hb.value), true)}` : "jamais démarré" },
    { name: "Ollama (local, gratuit)", ok: ai.local.length > 0, detail: ai.local.length ? ai.local.map((m) => m.id).join(", ") : "aucun modèle local détecté" },
    { name: "Quotas gratuits", ok: ai.quota.length > 0, detail: ai.providers.filter((p) => p.costClass === "free_quota").map((p) => `${p.id} : ${p.configured ? "clé présente" : "non configuré"}`).join(" · ") },
    { name: "Anthropic (payant, facultatif)", ok: true, detail: `${ai.anthropicConfigured ? "clé LOIC_OS_ANTHROPIC_API_KEY présente" : "non configuré"} · politique : ${ai.policy === "free_only" ? "100 % gratuit (bloqué)" : "payant autorisé"}` },
    { name: "Embeddings", ok: !!process.env.VOYAGE_API_KEY, detail: process.env.VOYAGE_API_KEY ? "clé présente — intégration non implémentée" : "non configurés (recherche plein texte + trigrammes)" },
  ];
  return (
    <>
      <PageHeader title="System Health" subtitle="État mesuré au chargement de la page." />
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Services">{services.map((s) => <div key={s.name} className="flex gap-2 items-center text-[13px] border-t border-line py-1.5"><span className={`size-2 rounded-full ${s.ok ? "bg-ok" : "bg-warn"}`} /><span className="w-40">{s.name}</span><span className="text-muted">{s.detail}</span></div>)}</Card>
        <Card title="File de tâches">{queue.length ? queue.map((q) => <div key={q.state} className="text-[13px]">{q.state} : {q.n}</div>) : <p className="text-[13px] text-faint">Schéma pg-boss absent (worker jamais démarré).</p>}</Card>
        <Card title="Intégrations">{integrations.map((i) => <div key={i.id} className="flex gap-2 text-[13px] py-1"><Badge tone={statusTone(i.status)}>{i.status}</Badge>{i.provider}{i.lastError && <span className="text-bad text-[12px]">{i.lastError}</span>}</div>)}
          <p className="text-[11px] text-faint mt-2">Aucune intégration n&apos;est déclarée connectée sans authentification réussie.</p></Card>
        <Card title="Coûts & budgets"><div className="text-[13px]">Jour : {usd(budget.dayUsd)} / {budget.limits.dayUsd} $ · Mois : {usd(budget.monthUsd)} / {budget.limits.monthUsd} $ {budget.blocked && <span className="text-bad">— {budget.blocked}</span>}</div></Card>
        <Card title="Intégrité du graphe"><div className="text-[13px] space-y-1"><div>Nœuds orphelins : {integ.orphanNodes.length ? integ.orphanNodes.map((o) => `${o.table} (${o.count})`).join(", ") : "aucun"}</div><div>Arêtes actives vers nœuds inactifs : {integ.activeEdgesOnInactiveNodes}</div><div>Entités sans nœud : {integ.entitiesWithoutNode.length ? integ.entitiesWithoutNode.map((e) => `${e.t} (${e.c})`).join(", ") : "aucune"}</div></div></Card>
        <Card title="Erreurs récentes">{errors.length ? errors.map((e, i) => <div key={i} className="text-[12px] border-t border-line py-1"><Badge tone="bad">{e.k}</Badge> {e.label?.slice(0, 60)} — <span className="text-bad">{e.error}</span></div>) : <p className="text-[13px] text-faint">Aucune.</p>}</Card>
        <Card title="Sauvegardes">{backups.length ? backups.slice(0, 5).map((b) => <div key={b.name} className="text-[13px]">{b.name} · {fmtDate(b.mtime, true)}</div>) : <p className="text-[13px] text-warn">Aucune sauvegarde trouvée dans ./backups — lancez <code>pnpm backup</code>.</p>}</Card>
        <Card title="Versions"><div className="text-[12px] text-muted">LOÏC OS {pkg.version} · Node {process.version} · {Object.entries(pkg.dependencies).map(([k, v]) => `${k} ${v}`).join(" · ")}</div></Card>
      </div>
    </>
  );
}
