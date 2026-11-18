import "dotenv/config";
import pg from "pg";
if (process.env.NODE_ENV === "production") throw new Error("reset interdit en production");
const url = process.argv[2] === "--test" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url });
// Supprime tout ce qui appartient au rôle applicatif ; les extensions (créées
// par le superutilisateur) sont conservées.
await pool.query(`DROP OWNED BY CURRENT_USER CASCADE`);
await pool.end();
console.log("✓ Base réinitialisée");
