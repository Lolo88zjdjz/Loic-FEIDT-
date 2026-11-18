/**
 * Niveaux d'autorisation LOÏC OS :
 *  1 Lecture · 2 Analyse · 3 Modification interne · 4 Action externe.
 * Règles :
 *  - un outil ne peut être appelé que si l'agent l'a dans sa liste ET si le
 *    niveau de l'outil ≤ plafond de l'agent ;
 *  - niveau 4 ⇒ toujours une ApprovalRequest (jamais d'exécution directe) ;
 *  - niveau 3 ⇒ exécution directe seulement si la préférence
 *    `security.auto_approve_internal` l'autorise (par défaut : oui pour la
 *    création, non pour la suppression — l'outil le déclare via `destructive`).
 *  - les transactions financières ne sont pas implémentées et sont interdites.
 */
export const PERMISSION_LABELS: Record<number, string> = {
  1: "Lecture", 2: "Analyse", 3: "Modification interne", 4: "Action externe",
};

export type PermissionDecision =
  | { allowed: true; requiresApproval: false }
  | { allowed: true; requiresApproval: true; reason: string }
  | { allowed: false; reason: string };

export function checkToolPermission(opts: {
  agentId: string; agentTools: string[]; agentLevel: number;
  toolName: string; toolLevel: number; destructive?: boolean; financial?: boolean;
  autoApproveInternal: boolean;
}): PermissionDecision {
  if (opts.financial) return { allowed: false, reason: "Les transactions financières sont interdites dans LOÏC OS." };
  if (!opts.agentTools.includes(opts.toolName))
    return { allowed: false, reason: `L'agent ${opts.agentId} n'est pas autorisé à utiliser l'outil ${opts.toolName}.` };
  if (opts.toolLevel > opts.agentLevel)
    return { allowed: false, reason: `Niveau ${opts.toolLevel} (${PERMISSION_LABELS[opts.toolLevel]}) au-dessus du plafond de ${opts.agentId} (niveau ${opts.agentLevel}).` };
  if (opts.toolLevel >= 4) return { allowed: true, requiresApproval: true, reason: "Action externe : approbation explicite requise." };
  if (opts.toolLevel === 3 && (opts.destructive || !opts.autoApproveInternal))
    return { allowed: true, requiresApproval: true, reason: opts.destructive ? "Modification destructive : validation requise." : "Validation des modifications internes activée." };
  return { allowed: true, requiresApproval: false };
}
