#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPT_FILE="${1:-$ROOT_DIR/prompts/periodic-message-prompt.txt}"
OUTPUT_FILE="${2:-$ROOT_DIR/out/periodic-message.txt}"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is required but was not found in PATH." >&2
  exit 1
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

PROMPT_CONTENT="$(cat "$PROMPT_FILE")"

codex exec \
  --ephemeral \
  --skip-git-repo-check \
  --sandbox workspace-write \
  -C "$ROOT_DIR" \
  -o "$OUTPUT_FILE" \
  "$PROMPT_CONTENT"

echo "$OUTPUT_FILE"
