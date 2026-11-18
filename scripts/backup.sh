#!/usr/bin/env bash
# Sauvegarde complète : base PostgreSQL (format custom) + fichiers du Knowledge Vault.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
mkdir -p backups
TS=$(date +%Y%m%d-%H%M%S)
pg_dump --format=custom --no-owner --file="backups/loic-os-$TS.dump" "$DATABASE_URL"
tar -czf "backups/storage-$TS.tar.gz" -C "${STORAGE_DIR:-./storage}" .
chmod 600 backups/*-"$TS".*
echo "✓ backups/loic-os-$TS.dump  +  backups/storage-$TS.tar.gz"
