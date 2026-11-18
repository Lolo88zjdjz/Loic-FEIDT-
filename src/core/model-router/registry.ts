/**
 * Registre initial des modèles. Les tarifs proviennent de la référence API
 * Claude intégrée à l'environnement de développement (cache daté du
 * 2026-11-03). La DISPONIBILITÉ n'est jamais supposée : elle reste
 * « unverified » tant qu'un appel à GET /v1/models n'a pas réussi avec la clé
 * de l'application (voir syncModelRegistry). Catalogue Anthropic : FACULTATIF et payant.
 */
export type ModelSeed = {
  id: string; displayName: string; tier: "fast" | "balanced" | "advanced" | "premium";
  inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok: number | null; cacheWritePerMtok: number | null;
  contextWindow: number; maxOutput: number; capabilities: string[]; limits: string;
};

export const PRICING_SOURCE = "Référence Claude API (skill claude-api, tableau « Current Models », cache du 2026-11-03). Écriture cache = 1,25 × entrée (TTL 5 min) ; lecture cache Haiku dérivée de la règle documentée 0,1 × entrée.";
export const PRICING_VERIFIED_AT = "2026-11-03";

export const MODEL_SEEDS: ModelSeed[] = [
  { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", tier: "fast", inputPerMtok: 0.1, outputPerMtok: 0.5, cacheReadPerMtok: 0.01, cacheWritePerMtok: 0.125,
    contextWindow: 1_000_000, maxOutput: 128_000, capabilities: ["tool_use", "adaptive_thinking", "effort", "structured_outputs", "vision"],
    limits: "Tarif valable jusqu'à 100K tokens de prompt (0,50 $ / 2,50 $ au-delà). Pas de repli serveur en cas de refus. Effort par défaut : medium." },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", tier: "balanced", inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.1, cacheWritePerMtok: 2.5,
    contextWindow: 1_000_000, maxOutput: 128_000, capabilities: ["tool_use", "adaptive_thinking", "effort", "structured_outputs", "vision", "web_search_20260209"],
    limits: "tool_choice forcé (any/tool) refusé (400). thinking disabled refusé : utiliser between_tools ou un effort bas." },
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", tier: "advanced", inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.2, cacheWritePerMtok: 5,
    contextWindow: 1_000_000, maxOutput: 128_000, capabilities: ["tool_use", "adaptive_thinking", "effort", "structured_outputs", "vision", "web_search_20260209"],
    limits: "Réflexion toujours active (effort = seul levier, défaut medium). tool_choice forcé refusé (400)." },
  { id: "claude-fable-5-2", displayName: "Claude Fable 5.2", tier: "premium", inputPerMtok: 8, outputPerMtok: 40, cacheReadPerMtok: 0.2, cacheWritePerMtok: 10,
    contextWindow: 1_000_000, maxOutput: 128_000, capabilities: ["tool_use", "adaptive_thinking", "effort", "vision", "web_search_20260209"],
    limits: "Jamais choisi automatiquement : réservé à une sélection manuelle. Rétention 30 jours requise." },
];
