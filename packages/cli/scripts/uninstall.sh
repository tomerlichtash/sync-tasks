#!/bin/bash
set -e

PLIST_DST="$HOME/Library/LaunchAgents/com.sync-tasks.plist"

# Stop if running
if launchctl list | grep -q "com.sync-tasks"; then
    launchctl unload "$PLIST_DST"
    echo "Stopped Tasks Sync"
fi

# Remove plist
if [ -f "$PLIST_DST" ]; then
    rm "$PLIST_DST"
    echo "Removed plist"
fi

echo ""
echo "✓ Tasks Sync uninstalled"
echo ""
echo "Note: Local sync state preserved at ~/.sync-tasks-state.json"
echo "      Delete it manually if you want a fresh start."
