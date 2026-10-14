#!/bin/sh
# Runs when a path under live/<ingestKey> gets its first publisher
# (MediaMTX's runOnReady hook). Reads the control app's destinations
# file for this ingest key and spawns one `ffmpeg -c copy` passthrough
# push per enabled destination, plus one into Owncast. No transcoding -
# literally the same bytes, re-muxed into FLV/RTMP.
set -eu

MTX_PATH="${MTX_PATH:-${RTSP_PATH:-}}"
INGEST_KEY=$(basename "$MTX_PATH")
SHARED_DIR="${FANOUT_SHARED_DIR:-/shared}"
DEST_FILE="$SHARED_DIR/${INGEST_KEY}.destinations"
STATUS_FILE="$SHARED_DIR/${INGEST_KEY}.status"
PID_FILE="$SHARED_DIR/${INGEST_KEY}.pids"
SOURCE_URL="rtmp://localhost:1935/${MTX_PATH}"

mkdir -p "$SHARED_DIR"
: > "$PID_FILE"
echo "{\"live\":true,\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"destinations\":[]}" > "$STATUS_FILE"

if [ ! -f "$DEST_FILE" ]; then
  echo "fanout: no destinations file for $INGEST_KEY yet ($DEST_FILE) - only passthrough happens until one is armed"
  exit 0
fi

names=""
sep=""
while IFS='|' read -r platform label target; do
  [ -z "$platform" ] && continue
  echo "fanout: pushing $MTX_PATH -> $platform ($label)"
  ffmpeg -nostdin -loglevel warning -re -i "$SOURCE_URL" -c copy -f flv "$target" \
    >>"$SHARED_DIR/${INGEST_KEY}.${platform}.log" 2>&1 &
  echo "$!" >> "$PID_FILE"
  names="${names}${sep}\"${platform}\""
  sep=","
done < "$DEST_FILE"

echo "{\"live\":true,\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"destinations\":[${names}]}" > "$STATUS_FILE"

# runOnReady must stay in the foreground for MediaMTX to track the hook's
# lifetime; wait on the background ffmpeg jobs we just started.
wait
