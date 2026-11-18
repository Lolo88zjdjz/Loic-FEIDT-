export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type Price = { inputPerMtok: string | number | null; outputPerMtok: string | number | null; cacheReadPerMtok: string | number | null; cacheWritePerMtok: string | number | null };

/** Coût calculé à partir de tokens MESURÉS (réponse API) et de tarifs enregistrés. */
export function computeCost(u: Usage, p: Price): { costUsd: number; status: "computed" | "partial" } {
  const parts: [number, string | number | null][] = [
    [u.inputTokens, p.inputPerMtok], [u.outputTokens, p.outputPerMtok],
    [u.cacheReadTokens, p.cacheReadPerMtok], [u.cacheWriteTokens, p.cacheWritePerMtok],
  ];
  let cost = 0; let partial = false;
  for (const [tokens, price] of parts) {
    if (!tokens) continue;
    if (price === null || price === undefined) { partial = true; continue; }
    cost += (tokens / 1_000_000) * Number(price);
  }
  return { costUsd: Math.round(cost * 1e6) / 1e6, status: partial ? "partial" : "computed" };
}
