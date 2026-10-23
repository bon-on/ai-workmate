#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Same label the bridge reads for /restart: env, then .env, then the neutral default.
ENV_LABEL="$(grep -E '^AI_WORKMATE_LAUNCHD_LABEL=' "$ROOT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
ENV_LABEL="${${ENV_LABEL#[\"\']}%[\"\']}"
LABEL="${AI_WORKMATE_LAUNCHD_LABEL:-${ENV_LABEL:-com.ai-workmate.bridge}}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="${AI_WORKMATE_STATE_DIR:-$HOME/.codex/ai-workmate}"
OUT_LOG="$STATE_DIR/launchd.out"
ERR_LOG="$STATE_DIR/launchd.err"
USER_ID="$(id -u)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
LAUNCH_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
case ":$LAUNCH_PATH:" in
  *":$NODE_DIR:"*) ;;
  *) LAUNCH_PATH="$NODE_DIR:$LAUNCH_PATH" ;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT_DIR/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$LAUNCH_PATH</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST"
launchctl bootout "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$USER_ID" "$PLIST"
launchctl enable "gui/$USER_ID/$LABEL"
launchctl kickstart -k "gui/$USER_ID/$LABEL"

echo "Installed and started LaunchAgent: $LABEL"
echo "Dashboard: http://127.0.0.1:8766/"
echo "Logs: $OUT_LOG, $ERR_LOG"
