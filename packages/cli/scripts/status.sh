#!/bin/bash
set -e

echo "=== Tasks Sync Status ==="
echo ""

if launchctl list | grep -q "com.sync-tasks"; then
    echo "Status: RUNNING"
    echo ""
    launchctl list | grep com.sync-tasks
else
    echo "Status: STOPPED"
fi

echo ""
echo "=== Recent Logs ==="
if [ -f /tmp/sync-tasks.log ]; then
    tail -20 /tmp/sync-tasks.log
else
    echo "(no logs yet)"
fi

echo ""
echo "=== Errors ==="
if [ -f /tmp/sync-tasks.error.log ] && [ -s /tmp/sync-tasks.error.log ]; then
    tail -10 /tmp/sync-tasks.error.log
else
    echo "(no errors)"
fi
