#!/bin/zsh

set -euo pipefail

N8N_BIN="/opt/homebrew/bin/n8n"
N8N_DIR="$HOME/.n8n"
LOG_FILE="$N8N_DIR/n8n.log"
PID_FILE="$N8N_DIR/n8n.pid"
SESSION_NAME="ai-workmate-n8n"
HOST="${N8N_HOST:-127.0.0.1}"
PORT="${N8N_PORT:-5678}"
TIMEZONE="${GENERIC_TIMEZONE:-Asia/Seoul}"
ACTION="${1:-start}"

mkdir -p "$N8N_DIR"

if [[ "$ACTION" == "__run" ]]; then
  exec env \
    N8N_HOST="$HOST" \
    N8N_PORT="$PORT" \
    TZ="$TIMEZONE" \
    GENERIC_TIMEZONE="$TIMEZONE" \
    "$N8N_BIN" start >>"$LOG_FILE" 2>&1
fi

if [[ "$ACTION" == "stop" || "$ACTION" == "restart" ]]; then
  screen -S "$SESSION_NAME" -X quit >/dev/null 2>&1 || true
  for _ in {1..50}; do
    current_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    [[ -z "$current_pid" ]] && break
    sleep 0.1
  done
  current_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [[ -n "$current_pid" ]]; then
    kill "$current_pid"
    for _ in {1..100}; do
      current_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
      [[ -z "$current_pid" ]] && break
      sleep 0.1
    done
  fi
  if [[ -n "${current_pid:-}" ]]; then
    echo "n8n did not stop cleanly (PID: $current_pid)." >&2
    exit 1
  fi
  rm -f "$PID_FILE"
  echo "Stopped n8n."
  [[ "$ACTION" == "stop" ]] && exit 0
elif [[ "$ACTION" != "start" ]]; then
  echo "Usage: $0 [start|stop|restart]" >&2
  exit 2
fi

existing_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "$existing_pid" ]]; then
  echo "n8n is already running (PID: $existing_pid)"
  echo "URL: http://$HOST:$PORT"
  exit 0
fi

screen -dmS "$SESSION_NAME" env \
  N8N_HOST="$HOST" \
  N8N_PORT="$PORT" \
  TZ="$TIMEZONE" \
  GENERIC_TIMEZONE="$TIMEZONE" \
  "$0" __run

for _ in {1..100}; do
  new_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ -n "$new_pid" ]] && break
  sleep 0.1
done

if [[ -z "${new_pid:-}" ]]; then
  echo "n8n did not open port $PORT. Check $LOG_FILE" >&2
  exit 1
fi

echo "$new_pid" > "$PID_FILE"

echo "Started n8n (PID: $new_pid)"
echo "URL: http://$HOST:$PORT"
echo "Timezone: $TIMEZONE"
echo "Log: $LOG_FILE"
