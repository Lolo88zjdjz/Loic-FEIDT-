# Mémoire persistante

## Modèle (`memories`)

`id, owner_id, content, type (identity|episodic|semantic|procedural|project|temporary), category, source_id, observed_at, valid_from, valid_until, status (active|superseded|expired|contested|deleted), sensitivity (public|personal|private|sensitive), confidence_status, project_id, supersedes_id, tags[], search (tsvector généré), embedding vector(1024)`.

**Confiance** = statut justifiable, jamais une probabilité : `user_confirmed` (vous l'avez dit/validé), `imported_historical` (profil initial 2025-2026, à actualiser), `document_extracted`, `agent_inferred`, `unverified`.

**Temporalité** : `observed_at` = date à laquelle l'information était vraie/connue. Si inconnue, date d'import + tag `date_inconnue`. `valid_until` dépassé ⇒ expiration automatique (worker, tâche « Santé du système »). Une préférence ancienne n'est jamais présentée comme actuelle : les agents reçoivent la date d'observation avec chaque souvenir.

## Opérations

| Opération | Comportement |
|---|---|
| Créer | Déduplication stricte (même contenu actif, même catégorie) ; révision 1 ; nœud Memory + liens |
| Corriger | Modification en place ; nouvelle révision (instantané complet) |
| Remplacer | Ancienne version → `superseded` (nœud archivé), nouvelle version avec `supersedes_id` + arête SUPERSEDES |
| Supprimer | Logique (récupérable) ; nœud retiré du graphe |
| Effacer définitivement | Supprime contenu, révisions et nœud |
| Restaurer | Retour à `active`, nœud recréé |
| Contradictions | Paires actives de même catégorie avec similarité trigramme 0,45–0,97 → à arbitrer par vous (jamais résolu automatiquement) |
| Export | JSON complet (Settings) |

## Recherche hybride

`websearch_to_tsquery('french')` (ts_rank_cd ×2) + `word_similarity` (pg_trgm, tolérance aux fautes) + bonus fraîcheur (≤ 0,15) + bonus `user_confirmed` (0,1). Le résultat indique comment chaque souvenir a été trouvé. **Composante vectorielle** : colonne et extension prêtes, aucun fournisseur d'embeddings configuré (Anthropic ne fournit pas d'embeddings ; Voyage AI recommandé dans le Plugin Center).

## Sélection de contexte par agent

`selectContextForAgent` ne renvoie que les catégories de `memory_scopes` de l'agent et une sensibilité ≤ son plafond. Exemple vérifié par test : DEALMAKER (scopes partnerships/communication/career, plafond `personal`) ne reçoit pas l'entorse de cheville (`health`, `sensitive`) ; VITAL (scopes sport/health, plafond `sensitive`) la reçoit, avec la consigne de demander si elle est toujours d'actualité.

## Apprentissage

Pas d'entraînement de modèle. L'amélioration passe par : mémoire procédurale (préférences), feedback d'agent convertible en préférence (refusé s'il touche aux règles de sécurité), prompts versionnés, routage ajustable.
