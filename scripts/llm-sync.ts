import "dotenv/config";
import { pool } from "../src/core/db/client";
import { syncModelRegistry } from "../src/core/llm/registry";
console.table(await syncModelRegistry());
await pool.end();
