import { PgBoss } from "pg-boss";

declare global { var __loicBoss: Promise<PgBoss> | undefined; }

export const AUTOMATION_QUEUE = "automation-run";

/** Instance pg-boss partagée (l'app web ne fait qu'ENVOYER des jobs ; le worker les exécute). */
export function boss(): Promise<PgBoss> {
  if (!globalThis.__loicBoss) {
    globalThis.__loicBoss = (async () => {
      const b = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: "pgboss" });
      b.on("error", (e) => console.error("[pg-boss]", e.message));
      await b.start({ supervise: false, schedule: false } as never);
      await b.createQueue(AUTOMATION_QUEUE, { retryLimit: 2, retryDelay: 60, retryBackoff: true } as never).catch(() => undefined);
      return b;
    })();
  }
  return globalThis.__loicBoss;
}

export async function enqueueAutomation(automationId: string) {
  const b = await boss();
  return b.send(AUTOMATION_QUEUE, { automationId, trigger: "manual" }, { singletonKey: `manual:${automationId}`, retryLimit: 2 } as never);
}
