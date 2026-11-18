/**
 * Worker durable LOÏC OS : planification cron (pg-boss, persistée dans
 * PostgreSQL) et exécution des automatisations. Lancement : `pnpm worker`.
 * Si le worker est arrêté, les jobs restent en file et sont rejoués au
 * redémarrage (politique de rattrapage pg-boss).
 */
import "dotenv/config";
import { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { db, schema, pool } from "../src/core/db/client";
import { runAutomation } from "../src/core/workflows/automations";
import { AUTOMATION_QUEUE } from "../src/core/workflows/queue";
import { audit } from "../src/core/security/audit";

type Job = { automationId: string; trigger: "schedule" | "manual" };

const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: "pgboss" });
boss.on("error", (e) => console.error("[worker] pg-boss:", e.message));
await boss.start();
await boss.createQueue(AUTOMATION_QUEUE, { retryLimit: 2, retryDelay: 60, retryBackoff: true } as never).catch(() => undefined);

async function syncSchedules() {
  const autos = await db.select().from(schema.automations);
  const existing = await boss.getSchedules(AUTOMATION_QUEUE);
  for (const s of existing) if (!autos.find((a) => a.id === s.key && a.enabled)) await boss.unschedule(AUTOMATION_QUEUE, s.key);
  for (const a of autos.filter((x) => x.enabled)) {
    await boss.schedule(AUTOMATION_QUEUE, a.cron, { automationId: a.id, trigger: "schedule" }, { tz: a.timezone, key: a.id });
  }
  console.log(`[worker] ${autos.filter((a) => a.enabled).length} automatisation(s) planifiée(s)`);
}

await boss.work<Job>(AUTOMATION_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const [a] = await db.select().from(schema.automations).where(eq(schema.automations.id, job.data.automationId));
    console.log(`[worker] ▶ ${a?.key ?? job.data.automationId} (${job.data.trigger})`);
    const r = await runAutomation(job.data.automationId, job.data.trigger, (job as unknown as { retryCount?: number }).retryCount ? ((job as unknown as { retryCount: number }).retryCount + 1) : 1);
    console.log(`[worker] ✓ ${a?.key}: ${r.status}`);
  }
});

await syncSchedules();
setInterval(() => syncSchedules().catch((e) => console.error("[worker] sync:", e.message)), 60_000);
// Battement de cœur (affiché dans System Health).
const beat = async () => db.insert(schema.userPreferences).values({ ownerId: (await db.select().from(schema.users).limit(1))[0]?.id, key: "system.worker_heartbeat", scope: "system", value: new Date().toISOString(), source: "worker" })
  .onConflictDoUpdate({ target: [schema.userPreferences.ownerId, schema.userPreferences.key], set: { value: new Date().toISOString(), updatedAt: new Date() } }).catch(() => undefined);
await beat(); setInterval(beat, 30_000);
await audit(db, { actor: "worker", action: "worker.started" });
console.log("[worker] prêt");

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await boss.stop({ graceful: true } as never); await pool.end(); process.exit(0); });
