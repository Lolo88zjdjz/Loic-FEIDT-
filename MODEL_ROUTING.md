# TOKEN MASTER — routage des modèles

TOKEN MASTER pilote **les modèles appelés par LOÏC OS via l'API Anthropic**. Il ne modifie pas le modèle de la session Claude Code de développement (réglage officiel : `/model` ou les paramètres de Claude Code).

## Registre (`model_definitions`)

| Modèle | Niveau | $/M entrée | $/M sortie | $/M cache lu | Usage cible |
|---|---|---|---|---|---|
| `claude-haiku-5-5` | fast | 0,10 | 0,50 | 0,01* | classification, extraction, résumé court, NUTRI/FLOW/SENTINEL |
| `claude-sonnet-5-5` | balanced | 2 | 10 | 0,10 | rédaction, recherche, analyse, la plupart des agents |
| `claude-opus-5-5` | advanced | 4 | 20 | 0,20 | stratégie (ORACLE), tâches complexes ou à risque |
| `claude-fable-5-2` | premium | 8 | 40 | 0,20 | jamais automatique : sélection manuelle uniquement |

Source : référence Claude API intégrée à l'environnement de développement (cache du 2026-11-03). *Lecture cache Haiku dérivée de la règle documentée 0,1 × entrée. Écriture cache = 1,25 × entrée. Haiku : tarif doublé au-delà de 100K tokens de prompt. **Disponibilité « unverified »** tant que `GET /v1/models` n'a pas réussi avec la clé de l'application (Settings → Vérifier).

## Algorithme (`chooseModel`)

1. Modèle imposé dans l'Agent Hub → utilisé tel quel.
2. Sinon niveau de l'agent ; risque élevé ou complexité élevée ⇒ **avancé directement** (pas d'escalade par essais) ; tâche simple ⇒ un niveau en dessous.
3. Recherche web ⇒ au moins Sonnet (outil `web_search_20260209` documenté pour Sonnet/Opus 5.5).
4. Mode : ECO descend d'un niveau (si risque faible), MAX PERFORMANCE monte d'un niveau.
5. Modèle marqué indisponible ⇒ bascule au niveau supérieur, sinon inférieur.
6. Effort (`output_config.effort`) : fast→low, balanced→medium, advanced→high ; ECO l'abaisse, MAX l'élève. (La réflexion ne peut pas être désactivée sur Opus/Sonnet 5.5 : l'effort est le levier.)
7. La justification complète est enregistrée (`agent_runs.model_reason`) et affichée dans les étapes d'exécution.

**Escalade** : une seule fois, uniquement sur critère vérifiable (réponse tronquée `max_tokens` au premier tour).

## Optimisations implémentées

- Routage déterministe : intentions reconnues traitées **sans aucun appel IA** (0 $).
- Préfixe système stable (règles + prompt d'agent) avec `cache_control` ; outils triés de façon déterministe ; la date et le contexte variable sont dans le message utilisateur (après le préfixe).
- Contexte mémoire ciblé (≤ 8 souvenirs, filtrés par catégorie et sensibilité de l'agent), historique limité aux 6 derniers messages.
- Sorties d'outils compressées (≤ 6 000 caractères), recherche web limitée (`max_uses: 3`).
- Plafonds : étapes par agent, 12 appels d'outils par run, 3 délégations, profondeur 2, 120 s, budget par agent, budgets jour/mois (blocage avant appel).
- Repli serveur en cas de refus (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) sur Opus/Sonnet 5.5 — désactivable (`LOIC_OS_REFUSAL_FALLBACK=0`).

## Mesure des coûts

`model_usage` enregistre par appel : tokens entrée / sortie / cache lu / cache écrit (renvoyés par l'API), modèle réellement servi, latence, statut, tentative. Coût = tokens × tarifs du registre ; `cost_status = partial` si un tarif manque. Aucune économie n'est affichée sans mesure.

## À distinguer

Abonnement Claude (claude.ai) ≠ usage Claude Code ≠ **facturation API** (clé de LOÏC OS, à l'usage) ≠ hébergement ≠ services tiers (Voyage, Google…). Un abonnement n'inclut pas d'accès API illimité.
