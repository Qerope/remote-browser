#!/usr/bin/env bash
# Installs the exit proxy as a macOS LaunchAgent (starts at login, restarts if it dies).
# Usage: tools/mac-exit/install.sh <this-mac-zerotier-ip> <server-zerotier-ip>
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <this-mac-zerotier-ip> <server-zerotier-ip>"; exit 1; }
NODE=$(command -v node) || { echo "node not found"; exit 1; }
DIR="$HOME/Library/Application Support/remote-browser-exit"
PLIST="$HOME/Library/LaunchAgents/com.remote-browser.exit.plist"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
cp "$(dirname "$0")/socks.js" "$DIR/socks.js"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.remote-browser.exit</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/socks.js</string></array>
  <key>EnvironmentVariables</key><dict><key>HOST</key><string>$1</string><key>ALLOW</key><string>$2</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/remote-browser-exit.log</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/remote-browser-exit.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.remote-browser.exit" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Exit proxy listening on $1:1080 for $2 only."
