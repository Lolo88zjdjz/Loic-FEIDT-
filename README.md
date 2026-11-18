# LOÏC OS

Second Brain personnel multi-agents : mémoire persistante, graphe de connaissances interactif (Neural Brain), 16 agents orchestrés par ATLAS, CRM, projets, Knowledge Vault, automatisations planifiées, contrôle des coûts IA (TOKEN MASTER) et inventaire vérifié des extensions (PLUGIN ARCHITECT).

> État réel, fonctionnalité par fonctionnalité : **[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)**.

## Stack

| Couche | Choix | Pourquoi |
|---|---|---|
| Web + API | Next.js 16 (App Router), React 19, TypeScript, Tailwind v4 | Monolithe modulaire : une seule app, server actions, API routes |
| Données | PostgreSQL 16 + Drizzle ORM + pgvector + pg_trgm | Une seule base pour relationnel, graphe, plein texte, vecteurs, file de tâches |
| File / planificateur | pg-boss 12 (dans PostgreSQL) | Durable, sans Redis ; reprise après arrêt |
| Graphe (UI) | Cytoscape.js + fcose | Rendu canvas fluide jusqu'à quelques milliers de nœuds |
| IA | `@anthropic-ai/sdk` (Messages API, boucle d'outils maison) | Chaque appel d'outil passe par SENTINEL et est journalisé |
| Validation | Zod 4 | Entrées API, formulaires et sorties LLM |

## Installation

Prérequis : Node 22+, pnpm 10+, PostgreSQL 16 avec les extensions `vector` (pgvector) et `pg_trgm`.

```bash
pnpm install
```

```bash
cp .env.example .env   # puis éditez SESSION_SECRET, LOIC_OS_OWNER_PASSWORD…
```

Création de la base (une fois, en superutilisateur, car `vector` n'est pas une extension « trusted ») :

```bash
sudo -u postgres psql -c "CREATE ROLE loic LOGIN PASSWORD 'loic_dev_password';" -c "CREATE DATABASE loic_os OWNER loic;" -c "CREATE DATABASE loic_os_test OWNER loic;"
```

```bash
for d in loic_os loic_os_test; do sudo -u postgres psql -d $d -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"; done
```

Migrations + données initiales (profil, projets, CRM, graphe, agents, modèles, automatisations) :

```bash
pnpm db:migrate && pnpm db:seed
```

## Lancement

```bash
pnpm build && pnpm start      # http://localhost:3000 (ou pnpm dev)
```

```bash
pnpm worker                   # planificateur + exécution des automatisations (processus séparé)
```

Connexion : `LOIC_OS_OWNER_EMAIL` / `LOIC_OS_OWNER_PASSWORD` définis dans `.env` au moment du seed (à changer ensuite dans Settings).

## Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `DATABASE_URL` | oui | Base de travail |
| `TEST_DATABASE_URL` | tests | Base dédiée aux tests (réinitialisée à chaque `pnpm test`) |
| `SESSION_SECRET` | oui | ≥ 32 caractères ; dérive aussi la clé AES-256-GCM des jetons OAuth |
| `LOIC_OS_OWNER_EMAIL` / `LOIC_OS_OWNER_PASSWORD` | seed | Compte propriétaire initial |
| `ANTHROPIC_API_KEY` | non | Active le mode LLM (demandes ouvertes, rédaction, recherche web). **Facturation API à l'usage, distincte d'un abonnement Claude ou de Claude Code.** Sans clé : mode déterministe (0 $). |
| `LOIC_OS_REFUSAL_FALLBACK` | non | `1` (défaut) : repli serveur en cas de refus (beta `server-side-fallback-2026-07-01`) |
| `VOYAGE_API_KEY` | non | Réservé aux embeddings (intégration non implémentée) |
| `GOOGLE_CLIENT_ID` / `SECRET` | non | Réservé à Gmail/Calendar/Drive (non implémenté) |
| `STORAGE_DIR` | non | Dossier des originaux du Vault (défaut `./storage`) |

## Tests

```bash
pnpm typecheck
```

```bash
pnpm test            # unitaires + intégration (base de test réelle, aucun appel API facturé)
```

```bash
pnpm test:e2e        # navigateur réel (Playwright) — l'app doit tourner sur :3000
```

```bash
pnpm graph:check     # intégrité graphe ↔ données métier (code de sortie ≠ 0 si incohérence)
```

## Sauvegarde / restauration

```bash
pnpm backup          # backups/loic-os-<date>.dump + backups/storage-<date>.tar.gz
```

```bash
./scripts/restore.sh backups/loic-os-<date>.dump backups/storage-<date>.tar.gz
```

La base cible doit déjà contenir les extensions `vector` et `pg_trgm` (voir Installation). Export applicatif JSON (sans secrets) : Settings → « Exporter toutes mes données » ou `GET /api/export`.

## Déploiement (recommandation)

Un seul hôte suffit : PostgreSQL managé avec pgvector (Neon, Supabase, RDS…), l'app Next.js (`pnpm start`) et le worker (`pnpm worker`) comme deux processus, derrière HTTPS. Le choix d'hébergeur a des conséquences de coût et de confidentialité : **non effectué, à décider par vous.** `NODE_ENV=production` active les cookies `Secure`.

## Étendre le système

- **Ajouter un agent** : une entrée dans `src/core/agents/definitions.ts` (prompt, outils, portée mémoire, plafond de sensibilité et de permission, évaluations de routage), puis `pnpm db:seed` (resynchronise les registres sans toucher vos données). Les tests de routage s'exécutent automatiquement.
- **Ajouter un outil** : une entrée dans `src/core/agents/tools.ts` (schéma Zod, niveau 1–4, `preview` si niveau ≥ 3), puis l'ajouter à la liste `tools` des agents concernés.
- **Ajouter un plugin / intégration** : vérifier le paquet (éditeur, version, changelog), `pnpm add <pkg>@<version>`, l'ajouter au catalogue de `src/core/plugins/audit.ts`, relancer l'audit (Plugin Center).
- **Gérer les modèles** : `src/core/model-router/registry.ts` (tarifs + source + date de vérification) ; disponibilité vérifiée par Settings → « Vérifier la disponibilité » (`GET /v1/models`). Politique : [MODEL_ROUTING.md](MODEL_ROUTING.md).

## Documentation

[ARCHITECTURE](ARCHITECTURE.md) · [AGENTS](AGENTS.md) · [MEMORY_DESIGN](MEMORY_DESIGN.md) · [GRAPH_DESIGN](GRAPH_DESIGN.md) · [MODEL_ROUTING](MODEL_ROUTING.md) · [SECURITY](SECURITY.md) · [ROADMAP](ROADMAP.md) · [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) · [CLAUDE.md](CLAUDE.md)
