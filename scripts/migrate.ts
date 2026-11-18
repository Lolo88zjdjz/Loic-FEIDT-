import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const url = process.argv[2] === "--test" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url });
try {
  for (const ext of ["vector", "pg_trgm"]) {
    try { await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`); }
    catch (e) { console.error(`Extension ${ext} indisponible : créez-la en superutilisateur (voir README).`, (e as Error).message); throw e; }
  }
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("✓ Migrations appliquées sur", new URL(url!).pathname.slice(1));
} finally { await pool.end(); }
