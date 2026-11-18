# Architecture

Monolithe modulaire (une app Next.js + un worker), une seule base PostgreSQL. Pas de microservices : le volume (un utilisateur) ne les justifie pas.

```
┌─────────────────────────── A. EXPERIENCE (src/app, src/components) ───────────────────────────┐
│ Dashboard · Command Center · Neural Brain · Agents · Memory · Vault · Projects · CRM · Calendar │
│ Automations · Plugin Center · AI Cost Center · Activity · System Health · Settings             │
└──────────────┬───────────────────────────── server actions / API routes (auth + CSRF) ─────────┘
               ▼
┌── B. INTELLIGENCE (src/core/orchestration, src/core/agents) ──┐   ┌── E. OPTIMISATION & SÉCURITÉ ──┐
│ ATLAS : route() → workflow minimal                            │   │ model-router (TOKEN MASTER)    │
│   ├─ deterministic.ts : intentions reconnues, 0 $             │◄─►│ plugins/audit (PLUGIN ARCHITECT)│
│   ├─ llm.ts : boucle d'outils Anthropic (si clé)              │   │ security/ : permissions,       │
│   └─ engine.ts : runs, étapes, SENTINEL, approbations, limites│   │ injection, redact, crypto,audit│
└──────────────┬────────────────────────────────────────────────┘   └────────────────────────────────┘
               ▼
┌── C. NEURAL CORE (src/core/memory, graph, knowledge) ─────────┐   ┌── D. EXECUTION ────────────────┐
│ memories + memory_revisions · graph_nodes/edges/changes       │   │ tools.ts (registre, niveaux 1-4)│
│ knowledge_documents/chunks · recherche hybride (FTS+trgm)     │   │ workflows/ + worker (pg-boss)   │
│ graph/sync.ts : événements de domaine → graphe (même tx)      │   │ approvals · notifications       │
└──────────────┬────────────────────────────────────────────────┘   └────────────────────────────────┘
               ▼
        PostgreSQL 16 (pgvector, pg_trgm, schéma pgboss)
```

## Arborescence

| Chemin | Rôle |
|---|---|
| `src/core/db/schema.ts` | 34 tables (voir § Schéma) ; migrations SQL générées dans `drizzle/` |
| `src/core/memory/` | CRUD versionné, remplacement, expiration, recherche hybride, contradictions, sélection de contexte par agent |
| `src/core/graph/service.ts` | Upsert idempotent, liens, retrait, voisinage, chemins (BFS), intégrité |
| `src/core/graph/sync.ts` | Gestionnaires d'événements de domaine → graphe |
| `src/core/knowledge/` | Import, extraction (txt/md/csv/json/pdf/docx), découpage, recherche avec citations |
| `src/core/crm/`, `projects/`, `nutrition/` | Services métier (validés par Zod) |
| `src/core/agents/` | 16 définitions d'agents + registre d'outils |
| `src/core/orchestration/` | intent (routeur déterministe), engine (SENTINEL), deterministic, llm, atlas |
| `src/core/model-router/` | Registre des modèles, tarifs, routeur, budgets |
| `src/core/plugins/audit.ts` | Inventaire réel + vérification npm en direct |
| `src/core/workflows/` | 6 automatisations, envoi de jobs pg-boss |
| `src/core/security/` | Permissions, injection, masquage, chiffrement, audit |
| `worker/index.ts` | Planification cron + exécution (processus séparé) |
| `tests/` | unit, integration (base réelle), e2e (Playwright) |

## Flux d'une demande

1. `POST /api/chat` (auth + contrôle d'origine) → `handleMessage()`.
2. `route()` : intention par règles, sinon score par mots-clés des agents, sinon ATLAS. Étape `route` enregistrée.
3. Run racine ATLAS + run enfant de l'agent choisi (délégation enregistrée).
4. Intention reconnue → gestionnaire déterministe (outils via `executeTool`). Sinon, avec clé : `runAgentLLM` (TOKEN MASTER choisit modèle/effort, contexte mémoire filtré, outils, délégation ≤ 3, profondeur ≤ 2). Sans clé : « Ask My Brain » sans génération.
5. Chaque outil : SENTINEL (liste blanche, plafond, Zod, approbation si niveau 4 ou destructif) → `tool_invocations`.
6. Bilan SENTINEL, synthèse, message enregistré. L'Execution Graph est reconstruit depuis `agent_run_steps` + `tool_invocations` (jamais simulé).

## Arbitrages

- **Drizzle plutôt que Prisma** : pas de moteur binaire à télécharger, SQL visible, types inférés, migrations SQL lisibles.
- **Graphe en tables relationnelles** : volumes d'un individu (≤ 10⁵ arêtes), index sur source/target, BFS en mémoire. Une base graphe dédiée n'est envisagée que si une mesure le justifie.
- **pg-boss plutôt que BullMQ** : pas de Redis à opérer, tout est sauvegardé avec la base.
- **Routage déterministe d'abord** : explicable, testable, gratuit ; le LLM n'est appelé que pour ce qui l'exige.
- **Boucle d'outils maison** (Messages API) plutôt que Tool Runner ou Managed Agents : le cahier des charges impose une orchestration propre à l'application, avec contrôle et journalisation de chaque appel.
- **shadcn/ui non utilisé** : composants maison minimalistes, au même esprit (Tailwind), sans CLI de génération.

## Schéma

`users, sessions, user_preferences, sources, projects, memories, memory_revisions, knowledge_documents, knowledge_chunks, graph_nodes, graph_edges, graph_changes, tasks, milestones, decisions, goals, calendar_events, organizations, contacts, opportunities, opportunity_stage_history, interactions, agent_definitions, conversations, messages, agent_runs, agent_run_steps, tool_invocations, agent_feedback, model_definitions, model_usage, plugin_definitions, integration_connections, automations, automation_runs, approval_requests, audit_events, notifications, foods, food_log, captures`.

Conventions : `owner_id` sur toute donnée personnelle, `created_at`/`updated_at`, suppression logique pour les données importantes, historiques dédiés, contraintes d'unicité servant l'idempotence (`graph_nodes(owner, ref_table, ref_id)`, `graph_edges(source, target, type)`, `approval_requests.idempotency_key`, `knowledge_documents(owner, sha256)`).
