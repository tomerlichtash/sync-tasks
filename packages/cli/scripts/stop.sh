#!/bin/bash
set -e

PLIST_DST="$HOME/Library/LaunchAgents/com.sync-tasks.plist"

if launchctl list | grep -q "com.sync-tasks"; then
    launchctl unload "$PLIST_DST"
    echo "✓ Tasks Sync stopped"
else
    echo "Tasks Sync is not running."
fi
