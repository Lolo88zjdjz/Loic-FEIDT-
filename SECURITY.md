# Sécurité

| Exigence | Mise en œuvre |
|---|---|
| Authentification | Compte propriétaire, mot de passe bcrypt (coût 12), comparaison à temps homogène ; session = jeton aléatoire 256 bits, seul son SHA-256 est stocké ; cookie httpOnly, SameSite=Lax, Secure en production ; expiration 14 jours ; changement de mot de passe ⇒ toutes les sessions révoquées |
| Autorisations | Toutes les pages (layout) et routes API vérifient la session ; toutes les requêtes filtrent par `owner_id` |
| CSRF | Server actions (contrôle d'origine natif de Next.js) ; routes API mutantes : vérification `Origin` = hôte |
| Niveaux d'action | 1 Lecture · 2 Analyse · 3 Modification interne · 4 Action externe. Liste blanche d'outils par agent + plafond ; niveau 4 ⇒ ApprovalRequest systématique (prévisualisation, expiration 7–14 j, clé d'idempotence, exécution unique) ; niveau 3 destructif ou si l'auto-approbation est désactivée ⇒ approbation ; transactions financières interdites dans le code |
| SENTINEL | Point de passage unique (`executeTool`) : liste blanche, plafond, validation Zod, approbation, plafond de 12 appels/run, journalisation de chaque invocation, audit des refus |
| Injection de prompt | Contenus externes (documents, web, sorties d'outils, réponses d'autres agents) encapsulés dans `<untrusted_data>` ; détection de motifs FR/EN signalée à l'import ; règles système jamais construites à partir de contenu externe ; `SECURITY_RULES` ajoutées à chaque appel, non modifiables par feedback |
| Secrets | Jamais dans les prompts ni la base (clés en variables d'environnement) ; masquage automatique (`redact`) dans l'audit, les étapes et les erreurs ; jetons OAuth prévus chiffrés AES-256-GCM ; l'export exclut mots de passe, chemins et jetons |
| Données sensibles | Sensibilité par souvenir/nœud/arête ; agents plafonnés ; santé = `sensitive`, accessible au seul VITAL ; graphe : nœuds `sensitive` masqués par défaut |
| Fichiers | Taille ≤ 20 Mo, nom assaini, stockage par empreinte SHA-256 (mode 600), téléchargement toujours en pièce jointe + `nosniff` ; aucune exécution de contenu |
| En-têtes | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Powered-By` retiré |
| Rendu | Markdown maison sans HTML brut (pas d'XSS via réponses ou documents) ; liens externes `noopener` |
| Code tiers | Aucune installation automatique ; Plugin Center recommande, l'utilisateur décide |
| Audit | `audit_events` : connexions, refus, approbations, préférences, exports, automatisations, écritures métier |
| Sauvegarde / restauration / export / suppression | `pnpm backup`, `scripts/restore.sh`, export JSON, effacement définitif d'un souvenir |
| Chiffrement des communications | À assurer au déploiement (HTTPS / TLS PostgreSQL) — non applicable en local |

## Limites connues

- Mono-utilisateur (pas de rôles multiples).
- Pas de limitation de débit sur `/login` (à ajouter avant exposition publique).
- Pas de CSP stricte (le script de thème est inline).
- Détection d'injection heuristique : la vraie protection est l'encapsulation + le contrôle des outils.
