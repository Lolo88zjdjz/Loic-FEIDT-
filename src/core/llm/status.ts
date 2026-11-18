/** État IA affiché dans l'interface (aucun appel réseau : lit le registre). */
import os from "node:os";
import { db, schema } from "../db/client";
import { PROVIDERS, getCostPolicy } from "./registry";
import { ANTHROPIC_KEY_ENV } from "./providers/anthropic";

export async function aiStatus(ownerId: string) {
  const [policy, models] = await Promise.all([getCostPolicy(ownerId), db.select().from(schema.modelDefinitions)]);
  const avail = (cls: string) => models.filter((m) => m.costClass === cls && m.availability !== "unavailable" && m.enabled);
  const local = avail("local"); const quota = avail("free_quota"); const paid = models.filter((m) => m.costClass === "paid");
  const anthropicConfigured = (process.env[ANTHROPIC_KEY_ENV] ?? "").length > 0;
  const label = local.length ? `IA gratuite : ${local.length} modèle(s) local(aux)` : quota.length ? "IA gratuite : quota fournisseur" : "IA : mode déterministe";
  return { policy, local, quota, paid, anthropicConfigured, freeAvailable: local.length + quota.length > 0, label,
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, costClass: p.costClass, configured: p.isConfigured() })) };
}

/** Recommandation INDICATIVE de taille de modèle local selon la machine qui exécute LOÏC OS. */
export function hardwareRecommendation() {
  const ramGb = Math.round(os.totalmem() / 1024 ** 3);
  const cpus = os.cpus().length;
  const rec = ramGb < 8 ? { size: "1–3B (ex. qwen2.5:1.5b, qwen2.5:3b)", note: "Réponses courtes, outils simples." }
    : ramGb < 16 ? { size: "3–4B (ex. qwen2.5:3b, qwen3:4b)", note: "Bon compromis vitesse/qualité sur CPU." }
    : ramGb < 32 ? { size: "7–8B (ex. qwen2.5:7b, llama3.1:8b)", note: "Rédaction correcte ; lent sans GPU." }
    : { size: "14B (ex. qwen2.5:14b, qwen3:14b)", note: "Meilleure qualité ; GPU recommandé." };
  return { ramGb, cpus, platform: `${os.platform()} ${os.arch()}`, ...rec,
    caveat: "Estimation d'après la RAM de la machine qui exécute LOÏC OS ; la présence d'un GPU (non détectée ici) accélère fortement." };
}
