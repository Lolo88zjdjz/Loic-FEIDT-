#!/usr/bin/env bash
# Importe un fichier GGUF local dans Ollama (si `ollama pull` n'est pas accessible).
# Usage : ./scripts/import-gguf.sh /chemin/modele.gguf nom:tag
set -euo pipefail
FILE=${1:?fichier .gguf}; NAME=${2:?nom:tag}
printf 'FROM %s\nPARAMETER num_ctx 8192\n' "$FILE" > /tmp/Modelfile.loic
ollama create "$NAME" -f /tmp/Modelfile.loic && echo "✓ $NAME importé — lancez « pnpm llm:sync »"
