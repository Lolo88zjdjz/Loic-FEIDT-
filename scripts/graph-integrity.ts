import "dotenv/config";
import { db, schema, pool } from "../src/core/db/client";
import { integrityReport } from "../src/core/graph/service";
const users = await db.select().from(schema.users);
let bad = 0;
for (const u of users) {
  const r = await integrityReport(u.id);
  console.log(u.email, JSON.stringify(r));
  bad += r.orphanNodes.length + r.activeEdgesOnInactiveNodes + r.entitiesWithoutNode.length;
}
await pool.end();
process.exit(bad ? 1 : 0);
