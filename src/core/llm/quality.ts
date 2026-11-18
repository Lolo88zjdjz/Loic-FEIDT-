/**
 * Estimation du niveau de capacité d'un modèle LOCAL d'après son nombre de
 * paramètres. Ce n'est PAS un benchmark : c'est un ordre de grandeur affiché
 * comme tel, que les mesures observées (taux de succès) viennent compléter.
 */
export function parseParams(size: string | null): number | null {
  if (!size) return null;
  const m = /([\d.]+)\s*([BbMm])/.exec(size);
  if (!m) return null;
  return Number(m[1]) * (m[2].toLowerCase() === "m" ? 0.001 : 1);
}
export function estimateLocalQuality(size: string | null): { tier: number; basis: string } {
  const b = parseParams(size);
  if (b === null) return { tier: 1, basis: "Taille inconnue : niveau minimal par prudence." };
  const tier = b < 2 ? 1 : b < 5 ? 2 : b < 20 ? 3 : 4;
  return { tier, basis: `Estimation d'après la taille (${size}) : ${["", "très limité (classification, extraction courte)", "basique (résumés, outils simples)", "correct (rédaction courante)", "bon (analyse)"][tier]}. Pas un benchmark.` };
}
export const QUALITY_LABEL = ["", "très limité", "basique", "correct", "bon", "excellent"];
