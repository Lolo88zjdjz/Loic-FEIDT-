# TOKEN MASTER — fournisseurs, coûts et routage

## Principe : 100 % gratuit par défaut

| Classe | Fournisseurs | Coût | Activation |
|---|---|---|---|
| `local` | **Ollama** (modèles sur votre machine) | 0 $ — données locales | Ollama lancé + au moins un modèle |
| `free_quota` | Gemini, Groq, OpenRouter (`:free` uniquement), Mistral — API compatibles OpenAI | 0 $ dans la limite du quota ; au-delà : erreur 429, **jamais** de facturation ni de repli payant | Clé du fournisseur dans `.env` |
| `paid` | **Anthropic** (facultatif) | Facturé à l'usage | `LOIC_OS_ANTHROPIC_API_KEY` **et** politique « payant autorisé » (avec confirmation explicite) |

**Politique de coût** (`ai.cost_policy`, Settings) : `free_only` par défaut. Garde-fou central `assertCallAllowed` dans `callModel` (`src/core/llm/registry.ts`) : **tout** appel de modèle y passe ; un modèle payant est refusé (erreur 402) tant que la politique est gratuite. Testé unitairement et en intégration (même avec la politique « payant autorisé », sans clé dédiée : aucun appel payant).

## Séparation Claude Code ↔ LOÏC OS

L'abonnement Claude Code sert à **développer** LOÏC OS ; il n'est jamais utilisé par l'application. Le fournisseur Anthropic de LOÏC OS :
- lit uniquement `LOIC_OS_ANTHROPIC_API_KEY` ;
- impose `baseURL = https://api.anthropic.com` et `authToken = null` ;
- ignore donc `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` (présentes dans les environnements Claude Code). Test : `séparation Claude Code` dans `tests/unit/pure.test.ts`.

TOKEN MASTER ne pilote que les modèles de l'application, jamais celui de la session Claude Code (`/model` dans Claude Code).

## Abstraction (`src/core/llm/`)

`LlmProvider { id, costClass, isConfigured(), discover(), chat() }` avec un format neutre (messages, outils JSON Schema, appels d'outils, usage). Ajouter un fournisseur = une classe ; ajouter un service compatible OpenAI = une entrée dans `FREE_PRESETS`.

**Découverte réelle** (`syncModelRegistry`, au seed, via Settings → « Détecter les modèles », `pnpm llm:sync`, et chaque nuit dans « Santé du système ») : Ollama `/api/tags` + `/api/show` (capacités `tools`, contexte), `/models` des fournisseurs à quota configurés (OpenRouter : seuls les modèles à prix 0), catalogue Anthropic documenté. Un modèle absent devient `unavailable`.

**Niveau de capacité (1–5)** : local = estimé d'après la taille (< 2B → 1, < 5B → 2, < 20B → 3, sinon 4) ; Anthropic = gamme (Haiku 3, Sonnet 4, Opus/Fable 5). Toujours affiché avec sa justification, jamais présenté comme un benchmark ; les mesures réelles (latence, débit, taux de succès) sont affichées à côté dans l'AI Cost Center.

## Sélection (`selectModel`)

1. Exigences de la tâche : niveau minimal (niveau de l'agent ±1 selon complexité, risque, mode ECO/MAX), outils, recherche web, contexte.
2. Candidats = modèles activés, disponibles, d'un fournisseur configuré **et autorisés par la politique**.
3. Parmi ceux qui satisfont tout : **le moins coûteux** ; à coût égal (0 $), local d'abord (confidentialité, pas de quota), puis le **plus petit modèle suffisant** (plus rapide).
4. Si aucun ne satisfait tout : meilleur compromis autorisé, **exigences non satisfaites déclarées** dans la réponse (ex. « aucune recherche web effectuée »), et mention qu'un modèle payant conviendrait mais est bloqué. Jamais de bascule implicite vers un modèle payant.
5. Repli en cas d'erreur (Ollama arrêté, quota 429) : prochain candidat **autorisé**, une fois. Aucun modèle disponible ⇒ « Ask My Brain » sans génération.
6. Justification complète enregistrée (`agent_runs.model_reason`) et visible dans les étapes d'exécution.

## Adaptations aux petits modèles locaux

- Consignes renforcées (« si tu n'es pas certain, dis-le », « n'invente aucune personne ou organisation »), historique réduit (2 messages), sorties d'outils plus courtes, descriptions d'outils abrégées, **délégation désactivée** (un modèle de niveau ≤ 2 s'y perd).
- Mode « réflexion » (Qwen3) désactivé par défaut (`OLLAMA_THINK=1` pour l'activer).
- **SENTINEL après coup** : réponse sans aucune donnée (ni souvenir, ni outil, ni web) ⇒ étiquetée « non sourcée — supposition du modèle ».
- **Neutralisation des injections** connues dans tout contenu externe avant envoi au modèle (mesure : sans elle, les deux modèles testés obéissent à « IGNORE ALL PREVIOUS INSTRUCTIONS »).
- Chaque réponse locale porte la mention « générée localement par … (gratuit, niveau N) : vérifiez les faits importants ».

## Coûts

`model_usage` : tokens mesurés (Ollama : `prompt_eval_count` / `eval_count`), latence, `cost_status` = `free_local` | `free_quota` | `computed` | `partial`. Les budgets jour/mois ne concernent que les modèles payants.

## Résultats mesurés

Voir **[docs/FREE_MODELS_REPORT.md](docs/FREE_MODELS_REPORT.md)** (régénéré par `pnpm llm:eval`).
