#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
STATE_DIR="${AI_WORKMATE_STATE_DIR:-$HOME/.codex/ai-workmate}"
PID_FILE="$STATE_DIR/telegram-codex-bridge.pid"
LOG_FILE="$STATE_DIR/telegram-codex-bridge.log"
RESTART_DELAY_SECONDS="${BRIDGE_RESTART_DELAY_SECONDS:-10}"

mkdir -p "$STATE_DIR"

timestamp() {
  date "+%Y-%m-%dT%H:%M:%S%z"
}

case "${1:-}" in
  start)
    if [[ -f "$PID_FILE" ]]; then
      existing_pid="$(cat "$PID_FILE")"
      if kill -0 "$existing_pid" 2>/dev/null; then
        echo "Telegram Codex bridge is already running (PID: $existing_pid)"
        echo "Log: $LOG_FILE"
        exit 0
      fi
    fi

    if command -v screen >/dev/null 2>&1; then
      screen -dmS ai-workmate-bridge zsh -lc "exec '$SCRIPT_PATH' run >> '$LOG_FILE' 2>&1"
      sleep 1
      if [[ -f "$PID_FILE" ]]; then
        echo "Started Telegram Codex bridge supervisor (PID: $(cat "$PID_FILE"))"
      else
        echo "Started Telegram Codex bridge supervisor in screen session ai-workmate-bridge"
      fi
    else
      nohup "$0" run >>"$LOG_FILE" 2>&1 < /dev/null &!
      echo "$!" > "$PID_FILE"
      echo "Started Telegram Codex bridge supervisor (PID: $!)"
    fi
    echo "Log: $LOG_FILE"
    ;;

  stop)
    if [[ ! -f "$PID_FILE" ]]; then
      echo "Telegram Codex bridge is not running."
      exit 0
    fi

    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "Stop requested for Telegram Codex bridge supervisor (PID: $pid)"
    else
      echo "Stale PID file removed."
    fi
    rm -f "$PID_FILE"
    ;;

  status)
    if [[ -f "$PID_FILE" ]]; then
      pid="$(cat "$PID_FILE")"
      if kill -0 "$pid" 2>/dev/null; then
        echo "Telegram Codex bridge supervisor is running (PID: $pid)"
        echo "Log: $LOG_FILE"
        exit 0
      fi
    fi

    echo "Telegram Codex bridge supervisor is not running."
    ;;

  run)
    supervisor_pid="$$"
    child_pid=""
    cleanup() {
      [[ -n "$child_pid" ]] && kill "$child_pid" 2>/dev/null || true
      if [[ -f "$PID_FILE" ]] && [[ "$(cat "$PID_FILE")" == "$supervisor_pid" ]]; then
        rm -f "$PID_FILE"
      fi
      exit 0
    }
    trap cleanup INT TERM
    echo "$supervisor_pid" > "$PID_FILE"

    while true; do
      echo "[$(timestamp)] Starting Telegram Codex bridge..."
      (
        cd "$ROOT_DIR"
        npm start
      ) &
      child_pid="$!"
      set +e
      wait "$child_pid"
      exit_code="$?"
      set -e
      child_pid=""
      echo "[$(timestamp)] Telegram Codex bridge exited with code $exit_code. Restarting in ${RESTART_DELAY_SECONDS}s."
      sleep "$RESTART_DELAY_SECONDS"
    done
    ;;

  *)
    echo "Usage: $0 start|stop|status"
    exit 2
    ;;
esac
