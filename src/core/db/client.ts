import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** Transaction ou base : les services acceptent l'un ou l'autre. */
export type Tx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

declare global {
  // eslint-disable-next-line no-var
  var __loicPool: pg.Pool | undefined;
}

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL manquant (voir .env.example)");
  return url;
}

export const pool: pg.Pool = globalThis.__loicPool ?? new pg.Pool({ connectionString: databaseUrl(), max: 10 });
if (process.env.NODE_ENV !== "production") globalThis.__loicPool = pool;

export const db: DB = drizzle(pool, { schema });
export { schema };
