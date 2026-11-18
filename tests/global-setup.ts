import "dotenv/config";
import { execSync } from "node:child_process";

export default function setup() {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL manquant");
  execSync("npx tsx scripts/reset.ts --test && npx tsx scripts/migrate.ts --test", { stdio: "inherit" });
}
