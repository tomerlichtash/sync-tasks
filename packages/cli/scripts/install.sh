#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.tasks-sync.plist"
PLIST_SRC="$CLI_DIR/launchd/$PLIST_NAME"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
BINARY="$CLI_DIR/.build/release/tasks-sync"

echo "=== Tasks Sync Installer ==="
echo ""

# Check if binary exists
if [ ! -f "$BINARY" ]; then
    echo "Building tasks-sync..."
    cd "$CLI_DIR"
    swift build -c release
fi

# Check for required environment variables
if [ -z "$WEBHOOK_URL" ]; then
    echo "Error: WEBHOOK_URL environment variable is required"
    echo ""
    echo "Usage:"
    echo "  WEBHOOK_URL=https://... WEBHOOK_SECRET=... ./install.sh"
    exit 1
fi

if [ -z "$WEBHOOK_SECRET" ]; then
    echo "Error: WEBHOOK_SECRET environment variable is required"
    exit 1
fi

# Generate plist with correct paths and secrets
cat > "$PLIST_DST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tasks-sync</string>

    <key>ProgramArguments</key>
    <array>
        <string>$BINARY</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>WEBHOOK_URL</key>
        <string>$WEBHOOK_URL</string>
        <key>WEBHOOK_SECRET</key>
        <string>$WEBHOOK_SECRET</string>
    </dict>

    <key>StartInterval</key>
    <integer>900</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/tasks-sync.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/tasks-sync.error.log</string>
</dict>
</plist>
EOF

echo "Installed plist to: $PLIST_DST"

# Load the agent
launchctl load "$PLIST_DST"

echo ""
echo "✓ Tasks Sync installed and running!"
echo ""
echo "Sync will run every 15 minutes and on login."
echo ""
echo "Commands:"
echo "  View logs:    tail -f /tmp/tasks-sync.log"
echo "  Run now:      launchctl start com.tasks-sync"
echo "  Stop:         scripts/stop.sh"
echo "  Uninstall:    scripts/uninstall.sh"
