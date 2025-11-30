#!/bin/bash

PLIST_DST="$HOME/Library/LaunchAgents/com.tasks-sync.plist"

# Stop if running
if launchctl list | grep -q "com.tasks-sync"; then
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
echo "Note: Local sync state preserved at ~/.tasks-sync-state.json"
echo "      Delete it manually if you want a fresh start."
