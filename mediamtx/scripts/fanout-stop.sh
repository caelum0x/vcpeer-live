#!/bin/sh
# Runs when a live/<ingestKey> path loses its publisher (MediaMTX's
# runOnNotReady hook). Normally the ffmpeg pushes started by fanout.sh
# exit on their own once the source RTMP read hits EOF; this is just the
# safety net in case any are left behind, plus marking status offline so
# the control app's "live" pill flips back immediately.
set -eu

MTX_PATH="${MTX_PATH:-${RTSP_PATH:-}}"
INGEST_KEY=$(basename "$MTX_PATH")
SHARED_DIR="${FANOUT_SHARED_DIR:-/shared}"
STATUS_FILE="$SHARED_DIR/${INGEST_KEY}.status"
PID_FILE="$SHARED_DIR/${INGEST_KEY}.pids"

echo "{\"live\":false,\"destinations\":[]}" > "$STATUS_FILE"

if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi
