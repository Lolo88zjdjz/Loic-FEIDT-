# CLAUDE.md — LOÏC OS

Second Brain personnel de Loïc. Lire d'abord `IMPLEMENTATION_STATUS.md` (état réel), puis `ARCHITECTURE.md`.

## Commandes

- `pnpm dev` / `pnpm build && pnpm start` (port 3000) · `pnpm worker` (automatisations, processus séparé)
- `pnpm typecheck` · `pnpm test` (unit + intégration ; réinitialise **la base de test** `TEST_DATABASE_URL`, jamais la base de travail) · `pnpm test:e2e` (app lancée requise) · `pnpm graph:check`
- `pnpm db:generate` (après modification de `src/core/db/schema.ts`) puis `pnpm db:migrate`
- `pnpm db:seed` : idempotent — si le propriétaire existe, resynchronise seulement agents/modèles/automatisations/plugins
- PostgreSQL local : `service postgresql start` ; extensions `vector` et `pg_trgm` à créer en superutilisateur

## Conventions

- Logique métier dans `src/core/*` uniquement ; pages et routes = fines couches (auth, validation, appel de service).
- Toute écriture métier passe par un service qui émet un événement de domaine (`emit`) **dans la même transaction** → graphe synchronisé. Ne jamais écrire dans `graph_nodes` depuis l'UI.
- Tout appel d'outil d'agent passe par `executeTool` (SENTINEL). Nouvel outil = schéma Zod + niveau 1–4 + `preview` si niveau ≥ 3.
- Données personnelles : toujours filtrer par `owner_id`.
- UI : Tailwind v4, tokens CSS dans `globals.css` (classes maison dans `@layer components`), composants dans `src/components/ui.tsx`. Texte en français.
- Next.js 16 : `params`/`searchParams`/`cookies()` sont asynchrones.

## Règles de sécurité (non négociables)

- Ne jamais inventer : souvenirs, sources, résultats, coordonnées, connexions, réservations. Afficher « non configuré / bloqué » plutôt que simuler.
- Aucune action externe sans `approval_requests` ; aucune transaction financière ; aucune installation automatique de dépendance.
- Contenu externe → `wrapUntrusted` ; secrets → jamais dans prompts/logs (`redactSecrets`).
- Données `sensitive` (santé) : accessibles uniquement aux agents dont `maxSensitivity` = `sensitive`.
- Ne pas confondre agents LOÏC OS (application) et subagents Claude Code (développement). TOKEN MASTER ne pilote pas le modèle de la session Claude Code.

## API Claude

SDK `@anthropic-ai/sdk`, `client.beta.messages.create` (pour `fallbacks`). Modèles : `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` (Fable 5.2 manuel seulement). Pas de `thinking.disabled` ni `budget_tokens` (400) ; contrôle via `output_config.effort`. Pas de `tool_choice` forcé (400 sur Opus/Sonnet 5.5). Outil web : `web_search_20260209`. Vérifier toute évolution dans la documentation officielle avant de modifier `src/core/orchestration/llm.ts`.

## Priorités

Sécurité > fiabilité > mémoire persistante > cohérence du graphe > exécution réelle > qualité des agents > UX > coût > performance > extensions.

## Validation avant commit

`pnpm typecheck && pnpm test` doivent passer ; après une modification d'UI, `pnpm build && pnpm start` puis `pnpm test:e2e`. Mettre à jour `IMPLEMENTATION_STATUS.md` (implémenté / testé / partiel / bloqué).
