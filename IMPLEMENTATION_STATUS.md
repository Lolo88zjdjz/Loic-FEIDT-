# État d'implémentation — mis à jour le 2026-11-18

Légende : ✅ implémenté **et testé** · 🟡 implémenté, non testé de bout en bout ou partiel · ⛔ bloqué (dépendance externe) · ⬜ non commencé.

## Environnement constaté

Node 22.23, pnpm 10.28, PostgreSQL 16.15 local (+ pgvector 0.6 installé via apt, pg_trgm), Chromium/Playwright disponibles, accès au registre npm. **Aucune clé `ANTHROPIC_API_KEY` pour l'application** ⇒ aucune exécution LLM n'a eu lieu ; aucun coût API n'a été généré.

## Tests exécutés (résultats réels)

| Suite | Commande | Résultat |
|---|---|---|
| Typage | `pnpm typecheck` | ✅ 0 erreur |
| Build production | `pnpm build` | ✅ (1 avertissement Turbopack de traçage de fichiers, sans effet) |
| Unitaires | `pnpm test` (tests/unit) | ✅ 52/52 — permissions, injection, secrets, chiffrement, coûts, routeur modèles, routage des 16 agents (évaluations), macros, découpage, conflits, chemins |
| Intégration (PostgreSQL réel) | `pnpm test` (tests/integration) | ✅ 24/24 — extraction PDF (par page) et DOCX, persistance après reconnexion, révisions, remplacement, isolation sensible, contradictions, sync CRM→graphe idempotente, intégrité, Vault (citations, doublons, versions, injection, format non pris en charge), nutrition, scénarios ATLAS B/D/E/G, refus SENTINEL, approbation idempotente, budgets, export sans secrets, automatisations |
| Bout en bout (navigateur) | `pnpm test:e2e` | ✅ 25/25 — voir critères ci-dessous ; aucune erreur JS ; mobile 390 px sans débordement |
| Intégrité graphe | `pnpm graph:check` | ✅ aucun orphelin |
| Sauvegarde / restauration | `pnpm backup` + `pg_restore` dans une base vierge (extensions pré-créées) | ✅ données restaurées |

Défauts trouvés et corrigés grâce aux tests : 3 erreurs de routage, passage de tableaux en SQL brut (`ANY`), arête active vers un souvenir remplacé, canevas du graphe à 0 px (classe CSS injectée par Cytoscape + `calc` invalide), classes CSS écrasant les utilitaires Tailwind, débordement mobile.

## Critères d'acceptation

| # | Critère | État | Preuve |
|---|---|---|---|
| 1 | Lancer l'application | ✅ | `pnpm start` + `pnpm worker`, e2e |
| 2 | Se connecter | ✅ | e2e (refus mauvais mot de passe, redirection sans session) |
| 3 | Consulter mes projets | ✅ | 7 projets initialisés, e2e |
| 4 | Discuter avec ATLAS | ✅ déterministe / 🟡 LLM | e2e « point global » ; mode LLM codé, non exécuté (pas de clé) |
| 5 | Exécuter un agent | ✅ | NUTRI, DEALMAKER, ORACLE, FLOW, TOKEN MASTER, PLUGIN ARCHITECT, SENTINEL (e2e + intégration) |
| 6 | Enregistrer un souvenir | ✅ | Memory Center, chat « retiens que… », e2e |
| 7 | Retrouver ce souvenir après redémarrage | ✅ | test d'intégration (nouvelle connexion) ; souvenirs E2E présents après plusieurs redémarrages du serveur |
| 8 | Importer un document | ✅ | e2e (Markdown) ; intégration : MD, PDF texte (pages), DOCX, PNG (conservé, non lu) |
| 9 | L'interroger avec sources | ✅ | passages cités (document, n° de passage, page, positions) |
| 10 | Visualiser un graphe réel | ✅ | 150+ nœuds réels, e2e |
| 11 | Cliquer sur un nœud | ✅ | e2e (panneau détaillé) |
| 12 | Comprendre ses relations | ✅ | provenance, validation (confirmée / hypothèse), source, historique |
| 13 | Créer une tâche | ✅ | e2e |
| 14 | Ajouter une entreprise au CRM | ✅ | e2e |
| 15 | Consulter l'historique des agents | ✅ | Agent Hub + Activity (Execution Graph) |
| 16 | Voir les coûts réels | ✅ | AI Cost Center — affiche 0 $ (aucun appel API réel) ; calcul testé unitairement |
| 17 | Modifier des préférences | ✅ | mode ECO persisté (e2e) |
| 18 | Refuser une action sensible | ✅ | refus d'un brouillon d'e-mail (e2e + intégration) |
| 19 | Plugins avec statut vérifié | ✅ | 42 entrées, versions vérifiées en direct sur npm |
| 20 | Comprendre pourquoi un modèle a été choisi | ✅ | étapes `model_select` + `model_reason` ; routeur testé |
| 21 | Exporter mes données | ✅ | e2e (JSON, sans secrets) |

## Par module

| Module | État | Détail / limites |
|---|---|---|
| Auth & sessions | ✅ | Mono-utilisateur ; pas de rate limiting |
| Mémoire | ✅ | 6 types, révisions, remplacement, expiration, contradictions, export ; embeddings ⬜ |
| Graphe + sync | ✅ | 10 types d'événements de domaine ; vue 3D ⬜ |
| Neural Brain UI | ✅ | zoom, recherche, filtres (type, période, inférées), focus, chemins, panneau, agents actifs, chargement progressif |
| Execution Graph | ✅ | reconstruit depuis les étapes enregistrées |
| Knowledge Vault | ✅ | txt/md/csv/json/PDF texte/DOCX ✅ ; XLSX ⬜ ; OCR ⬜ (PDF scannés et images conservés, signalés non lus) |
| Projets, tâches, décisions, objectifs, calendrier local | ✅ | Milestones : table seulement |
| CRM (2 pipelines, chronologie, historique d'étapes) | ✅ | |
| ATLAS déterministe (18 intentions) | ✅ | |
| ATLAS / agents LLM (boucle d'outils, délégation, web search, cache, fallbacks) | 🟡 | **Non exécuté** : nécessite `ANTHROPIC_API_KEY` |
| TOKEN MASTER | ✅ | Disponibilité des modèles « unverified » tant que la clé n'est pas fournie |
| PLUGIN ARCHITECT | ✅ / 🟡 | Inventaire réel ✅ ; découverte de nouveaux outils par recherche web 🟡 (clé) |
| Automatisations (6) + worker pg-boss | ✅ | Briefing, suivi partenariats, révisions, weekly review, santé système exécutés ; veille stages ⛔ sans clé |
| Approbations | ✅ | Gmail non connecté ⇒ l'envoi approuvé échoue explicitement |
| Intégrations Gmail / Calendar / Drive / Notion / GitHub | ⛔ | OAuth non implémenté ; nécessite vos identifiants Google Cloud. Statut « not_connected » affiché honnêtement |
| Universal Capture | ✅ | Classement suggéré déterministe |
| Agent Feedback | ✅ | Conversion en préférence, refus si cela touche la sécurité |
| System Health | ✅ | Services, worker, file, intégrations, erreurs, coûts, intégrité, sauvegardes, versions |
| Évaluations IA (qualité LLM) | ⬜ | Seules les évaluations de routage existent (déterministes) |

## Blocages (votre intervention)

1. **Clé API Anthropic** pour l'application (facturation API distincte de votre abonnement) — débloque rédaction, recherche web, veille stages, génération d'exercices, vérification des modèles.
2. **Projet Google Cloud + OAuth** (client ID/secret) pour Gmail/Calendar/Drive.
3. **Fournisseur d'embeddings** (ex. Voyage AI) si vous voulez la recherche vectorielle.
4. **Choix d'hébergement** (coût / confidentialité).

## Données initiales

Profil importé comme **historique** (`imported_historical`, daté) : 48 souvenirs, 7 projets, 30 organisations (4 en discussion, 22 prospects « identified », écoles/association), 1 contact, 26 opportunités, 4 échanges, 5 objectifs, 1 événement provisoire (Thaïlande, non réservé), 7 tâches suggérées (créées par `atlas:suggestion`, supprimables), 18 aliments à valeurs **estimées**, 8 relations inférées étiquetées.
