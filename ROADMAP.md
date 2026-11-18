# Roadmap

| Phase | Contenu | État |
|---|---|---|
| 1 Fondations | Projet, base, auth, design system, navigation, config, tests | ✅ |
| 2 Neural Core | Nœuds, arêtes, mémoire, recherche, provenance, visualisation, synchronisation | ✅ (sans embeddings) |
| 3 ATLAS | Conversation, routage, historique, tool calling, mémoire contextuelle | ✅ déterministe · ⚠️ LLM non testé (pas de clé) |
| 4 TOKEN MASTER | Registre, routage, coûts, budgets, modes | ✅ |
| 5 Agents métiers | NEXUS, DEALMAKER, SCHOLAR, ATHENA puis les autres | ⚠️ définis et exécutables ; capacités rédactionnelles dépendantes de la clé |
| 6 Vault & projets | Documents, indexation, recherche, projets, tâches, CRM | ✅ (OCR/XLSX à faire) |
| 7 PLUGIN ARCHITECT | Audit, catalogue, compatibilité, permissions | ✅ inventaire vérifié · ⏳ recherche web de nouveaux outils |
| 8 Automatisations | Scheduler, workers, notifications, suivi | ✅ (veille stages bloquée sans clé) |
| 9 Intégrations | Gmail, Calendar, Drive | ⏳ non commencé (nécessite vos identifiants OAuth Google) |
| 10 Fiabilisation | Sécurité, performance, déploiement | ⏳ partiel |

## Prochaines étapes (ordre recommandé)

1. **Clé API Anthropic** → tester ATLAS LLM, NEXUS/ATHENA (web search), mesurer les premiers coûts réels.
2. Embeddings (Voyage) → composante vectorielle de la recherche hybride.
3. OAuth Google (Gmail brouillons → envoi approuvé, Calendar lecture, Drive import).
4. XLSX (exceljs), OCR (Claude vision) dans le Vault.
5. Évaluations IA automatisées sur réponses LLM (exactitude documentaire, permissions, injection) — nécessite la clé.
6. Limitation de débit de connexion, CSP, déploiement HTTPS.
