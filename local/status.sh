#!/bin/bash

echo "=== Tasks Sync Status ==="
echo ""

if launchctl list | grep -q "com.tasks-sync"; then
    echo "Status: RUNNING"
    echo ""
    launchctl list | grep com.tasks-sync
else
    echo "Status: STOPPED"
fi

echo ""
echo "=== Recent Logs ==="
if [ -f /tmp/tasks-sync.log ]; then
    tail -20 /tmp/tasks-sync.log
else
    echo "(no logs yet)"
fi

echo ""
echo "=== Errors ==="
if [ -f /tmp/tasks-sync.error.log ] && [ -s /tmp/tasks-sync.error.log ]; then
    tail -10 /tmp/tasks-sync.error.log
else
    echo "(no errors)"
fi
