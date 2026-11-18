# Neural Core — graphe de connaissances

## Stockage

- `graph_nodes` : `type` (Person, Organization, Project, Goal, Agent, Memory, Document, Task, Event, Skill, Knowledge, Decision, Opportunity, Tool, Integration, Automation, Model, Conversation, Topic, Source), `label`, `ref_table`/`ref_id` (entité métier synchronisée ; `native` pour les nœuds propres au graphe), `properties`, `status` (active | archived | deleted), `sensitivity`, `source_id`.
- `graph_edges` : `type` (WORKS_ON, BELONGS_TO, KNOWS, CONNECTED_TO, MENTIONS, DERIVED_FROM, RELATED_TO, DEPENDS_ON, USED_BY, GENERATED_BY, CONTRIBUTES_TO, REQUIRES, SUPERSEDES, ASSOCIATED_WITH), `provenance` (phrase lisible), `source_id`, `observed_at`, `status`, `validation` (**confirmed** | **inferred** | rejected), `confidence_note` (justification d'une inférence), `sensitivity`.
- `graph_changes` : historique de toute création / modification / retrait.

Index : unicité `(owner, ref_table, ref_id)` et `(source, target, type)` (idempotence), index source/target, trigrammes sur `label`.

## Synchronisation

Chaque service métier émet un événement de domaine **dans sa transaction** (`graph/sync.ts`) : projet, souvenir, organisation, contact, opportunité (+ arête Organisation —CONNECTED_TO→ Projet expliquée), tâche, document, objectif, décision, événement. Garanties : atomicité, idempotence (upserts), historique, propagation des suppressions (nœud retiré + arêtes retirées), une relation confirmée n'est jamais rétrogradée en inférée. Réconciliation : `pnpm graph:check` / System Health (nœuds orphelins, arêtes vers nœuds supprimés, entités sans nœud).

## Relations inférées

Créées seulement avec une justification (`confidence_note`) et affichées en pointillés, étiquetées « hypothèse » dans l'UI et dans les réponses. Exemple du seed : « Négociation B2B —CONTRIBUTES_TO→ Stage L3 » (inférée : correspond aux intérêts de l'automne 2026, non validée par un recruteur). Une relation professionnelle n'est jamais transformée en opportunité d'embauche.

## Parcours (GraphRAG)

`findPaths` : BFS non orienté, chemins simples ≤ 4 sauts, les plus courts d'abord, chaque saut expliqué par sa provenance. Utilisé par l'outil `graph_paths` (ORACLE, NEXUS, ATLAS) et l'UI. La recherche hybride combine plein texte (mémoire, documents), trigrammes (nœuds), parcours du graphe, métadonnées (sensibilité, statut, dates) et provenance.

## Visualisation

Cytoscape.js (canvas) + fcose. Comparaison : React Flow (DOM, conçu pour éditer des schémas, lent au-delà de ~500 nœuds), D3 force (beaucoup de code sur mesure), sigma.js (WebGL, idéal > 10 000 nœuds, moins riche en interactions). Cytoscape offre le meilleur compromis à cette échelle ; sigma.js est l'évolution si la taille l'exige (vue 3D non implémentée : jugée non pertinente à ce stade).

Fonctions : zoom, déplacement, sélection de nœud (panneau : description, source, relations avec provenance, historique, lien vers la fiche), sélection d'arête (explication), recherche, filtres par type (légende), période, relations inférées on/off, focus 2 sauts (filtre par projet), surlignage de chemin entre deux nœuds, anneau vert = agent ayant une exécution réelle dans l'heure, mise en évidence des éléments récents, chargement progressif (limite + « Charger plus »), disposition « grid » au-delà de 1 500 nœuds. Tool et Model masqués par défaut.

**Execution Graph** (Command Center → « Étapes d'exécution », Activity) : construit uniquement à partir de `agent_run_steps` et `tool_invocations` enregistrés.
