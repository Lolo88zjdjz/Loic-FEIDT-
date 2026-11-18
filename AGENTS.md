# Agents

Source de vérité : `src/core/agents/definitions.ts` (synchronisée en base par `pnpm db:seed`). Les agents de LOÏC OS sont des composants de l'application, **distincts des subagents de Claude Code** utilisés pour le développement.

Chaque agent possède : identifiant, nom, mission, description, instructions système versionnées (`promptVersion`), outils autorisés, catégories de mémoire accessibles, plafond de sensibilité, niveau de modèle (ou modèle imposé), budget par mission, nombre max d'étapes, plafond d'autorisation (1–4), historique (`agent_runs`), métriques (Agent Hub) et évaluations de routage (exécutées par `pnpm test` et à l'affichage de l'Agent Hub).

Les **règles de sécurité** (`SECURITY_RULES`) sont ajoutées par le moteur à chaque appel LLM ; elles ne sont pas modifiables par l'Agent Hub ni par un feedback.

| Agent | Rôle | Statut réel | Ce qui fonctionne sans clé API | Ce qui exige la clé |
|---|---|---|---|---|
| ATLAS | Chief of Staff, orchestrateur | opérationnel | routage explicable, point global, mémorisation, Ask My Brain sans génération, délégation | réponses rédigées, délégation LLM (≤ 3, profondeur ≤ 2) |
| NEXUS | Carrière | partiel | réseau ↔ objectifs (faits / hypothèses séparés) | recherche d'offres réelles, CV, entretiens |
| DEALMAKER | Partenariats | opérationnel | dossier CRM daté, détection des relances, brouillon assemblé depuis le CRM (approbation, jamais d'envoi) | propositions et relances rédigées sur mesure |
| SCHOLAR | Études | partiel | recherche dans les cours avec citations | fiches, exercices, quiz, corrigés |
| ATHENA | Recherche | partiel | documents internes | web search avec sources et dates |
| VITAL | Sport | partiel | — | plans d'entraînement (santé : accès sensible explicite) |
| NUTRI | Nutrition | opérationnel | journal, macros, cumul, estimé vs vérifié (100 % déterministe) | menus, listes de courses |
| NOMAD | Voyages | partiel | — | itinéraires, budgets (aucune réservation inventée) |
| CAPITAL | Finance | partiel | — | VAN/TRI/scénarios rédigés ; transactions interdites |
| FLOW | Organisation | opérationnel | tâches, retards, conflits horaires | planification hebdomadaire rédigée |
| WORDSMITH | Rédaction | partiel | modèle de relance (via DEALMAKER) | rédaction libre |
| FORGE | Technique | prévu (lecture seule) | — | diagnostic ; aucune modification de code |
| SENTINEL | Contrôle | opérationnel | intégré au moteur : bloque, valide, audite chaque outil ; contradictions mémoire | vérification de réponses LLM |
| ORACLE | Stratégie | partiel | chemins du graphe entre entités / projets | analyses d'opportunités |
| PLUGIN ARCHITECT | Extensions | partiel | inventaire réel + versions npm vérifiées en direct | recherche de nouvelles intégrations sur le web |
| TOKEN MASTER | Coûts IA | opérationnel | routage modèle/effort, budgets, rapports mesurés | — |

« Partiel » = les outils, permissions, mémoire et prompts sont en place et exécutables via le moteur LLM, mais aucune exécution LLM n'a pu être testée dans cet environnement (pas de clé).

## Niveaux d'autorisation des outils

| Niveau | Outils |
|---|---|
| 1 Lecture | memory_search, graph_search_nodes, graph_neighborhood, docs_search, projects_overview, tasks_list, crm_overview, crm_org_dossier, calendar_upcoming, nutrition_day, decisions_list, plugins_audit |
| 2 Analyse | graph_paths, crm_stale, costs_report, web_search (serveur Anthropic) |
| 3 Modification interne | memory_create, task_create, crm_add_organization, crm_move_opportunity, nutrition_log, draft_email (crée une approbation, n'envoie rien) |
| 4 Action externe | email_send (toujours approbation ; Gmail non connecté ⇒ échec honnête) |

## v0.2 — exécution gratuite

Avec Ollama, tous les agents s'exécutent en mode LLM **sans coût** (modèle local choisi par TOKEN MASTER). Ce qui reste indisponible en mode gratuit : la **recherche web** (ATHENA, veille stages de NEXUS, recherche de nouveaux outils par PLUGIN ARCHITECT) et la **délégation** entre agents quand le modèle local est de niveau ≤ 2. La qualité rédactionnelle et analytique dépend de la taille du modèle local : voir [docs/FREE_MODELS_REPORT.md](docs/FREE_MODELS_REPORT.md).
