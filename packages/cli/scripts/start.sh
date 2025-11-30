#!/bin/bash
set -e

PLIST_DST="$HOME/Library/LaunchAgents/com.sync-tasks.plist"

if [ ! -f "$PLIST_DST" ]; then
    echo "Error: Tasks Sync not installed. Run ./install.sh first."
    exit 1
fi

# Check if already loaded
if launchctl list | grep -q "com.sync-tasks"; then
    echo "Tasks Sync is already running."
    echo "To run immediately: launchctl start com.sync-tasks"
else
    launchctl load "$PLIST_DST"
    echo "✓ Tasks Sync started"
fi

echo ""
echo "View logs: tail -f /tmp/sync-tasks.log"
