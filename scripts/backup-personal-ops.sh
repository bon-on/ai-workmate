#!/bin/zsh
set -euo pipefail

if [[ -z "${EXTERNAL_STORAGE_PATH:-}" ]]; then
  echo "EXTERNAL_STORAGE_PATH is required. Point it at an encrypted external volume."
  exit 1
fi

if [[ ! -d "$EXTERNAL_STORAGE_PATH" ]]; then
  echo "External storage is not mounted: $EXTERNAL_STORAGE_PATH"
  exit 1
fi

backup_root="$EXTERNAL_STORAGE_PATH/ai-workmate-backups"
timestamp="$(date +%Y%m%d-%H%M%S)"
destination="$backup_root/$timestamp"
mkdir -p "$destination"

state_root="${AI_WORKMATE_STATE_ROOT:-$HOME/.codex}"
for source_file in \
  "$state_root/telegram-codex-bridge-sessions.json" \
  "$state_root/telegram-codex-bridge-memories.json" \
  "$state_root/telegram-codex-bridge-schedules.json" \
  "$state_root/ai-workmate-personal-ops.json"; do
  if [[ -f "$source_file" ]]; then
    cp "$source_file" "$destination/"
  fi
done

n8n_database="${N8N_DATABASE_PATH:-$HOME/.n8n/database.sqlite}"
if [[ -f "$n8n_database" ]]; then
  sqlite3 "$n8n_database" ".backup '$destination/n8n-database.sqlite'"
fi

find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +30 -print
echo "Backup created: $destination"
echo "Old backups are listed above but never deleted automatically."
