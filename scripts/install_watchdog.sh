#!/bin/zsh

set -euo pipefail

# Installs a LaunchAgent that runs scripts/watchdog.js every 5 minutes, outside the bridge process.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${AI_WORKMATE_WATCHDOG_LABEL:-com.ai-workmate.watchdog}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="${AI_WORKMATE_STATE_DIR:-$HOME/.codex/ai-workmate}"
USER_ID="$(id -u)"
NODE_BIN="$(command -v node)"

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
    <string>$ROOT_DIR/scripts/watchdog.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$STATE_DIR/watchdog.out</string>
  <key>StandardErrorPath</key>
  <string>$STATE_DIR/watchdog.err</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST"
launchctl bootout "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$USER_ID" "$PLIST"

echo "Installed watchdog LaunchAgent: $LABEL (every 5 minutes)"
