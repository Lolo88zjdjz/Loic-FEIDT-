#!/usr/bin/env bash
# Restauration : ./scripts/restore.sh backups/loic-os-AAAAMMJJ-HHMMSS.dump [backups/storage-….tar.gz]
# ⚠️ Remplace le contenu actuel de la base. Arrêtez l'app et le worker avant.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
DUMP=${1:?Chemin du fichier .dump requis}
read -r -p "Remplacer la base $(basename "$DATABASE_URL") par $DUMP ? (oui/non) " OK
[ "$OK" = "oui" ] || { echo "Annulé."; exit 1; }
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DUMP"
if [ -n "${2:-}" ]; then mkdir -p "${STORAGE_DIR:-./storage}"; tar -xzf "$2" -C "${STORAGE_DIR:-./storage}"; fi
echo "✓ Restauration terminée"
