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

echo "{\"live\":false}" > "$STATUS_FILE"

if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# Safety net: push_one's own TERM trap (fanout.sh) already rewrites each
# destination's `<ingestKey>.<id>.state` file to "stopped" before exiting,
# but that's a race with the `kill` above - if this script's rewrite below
# loses the race, a destination's state would be stuck on its last
# in-flight value ("pushing"/"retrying") after the broadcast has actually
# ended. Force every state file for this ingest key to "stopped" here too,
# so the dashboard never shows stale per-destination health.
for state_file in "$SHARED_DIR/${INGEST_KEY}".*.state; do
  [ -e "$state_file" ] || continue
  case "$state_file" in
    *"${INGEST_KEY}.owncast.state") continue ;;
  esac
  tmp_file="${state_file}.tmp"
  sed 's/"state":"[^"]*"/"state":"stopped"/' "$state_file" > "$tmp_file" 2>/dev/null \
    && mv "$tmp_file" "$state_file" \
    || rm -f "$tmp_file"
done
