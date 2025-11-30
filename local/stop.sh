#!/bin/bash

PLIST_DST="$HOME/Library/LaunchAgents/com.tasks-sync.plist"

if launchctl list | grep -q "com.tasks-sync"; then
    launchctl unload "$PLIST_DST"
    echo "✓ Tasks Sync stopped"
else
    echo "Tasks Sync is not running."
fi
