#!/bin/bash
# STATUS.md monitor — checks for content changes every 30s
# Usage: ./monitor-status.sh [remote_host]

REMOTE="${1:-mmixx@192.168.3.14}"
STATUS_FILE="$HOME/workfolder/Nproxy/STATUS.md"
LAST_HASH=""

echo "[monitor] Watching STATUS.md from $REMOTE (Ctrl+C to stop)"

while true; do
    BEFORE_HASH=$(md5sum "$STATUS_FILE" 2>/dev/null | cut -d' ' -f1)

    # pull latest
    scp -q "$REMOTE:~/workfolder/Nproxy/STATUS.md" "$STATUS_FILE" 2>/dev/null

    AFTER_HASH=$(md5sum "$STATUS_FILE" 2>/dev/null | cut -d' ' -f1)

    if [ "$AFTER_HASH" != "$BEFORE_HASH" ] && [ -n "$BEFORE_HASH" ]; then
        echo ""
        echo "=== STATUS.md updated at $(date '+%H:%M:%S') ==="
        tail -20 "$STATUS_FILE"
        echo "==========================================="
        echo ""
        echo "[monitor] Updated at $(date '+%H:%M:%S')" >&2
    fi
    sleep 30
done
