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

# Retry tuning for the self-read race (see push_one below): a push that
# dies within RETRY_WINDOW_SECONDS of starting is treated as the probe
# race, not a real end of stream, and gets retried up to MAX_RETRIES times
# with a short backoff. A push that ran longer than the window before
# dying is assumed to be a legitimate stream end and is left alone.
MAX_RETRIES="${FANOUT_MAX_RETRIES:-3}"
RETRY_WINDOW_SECONDS="${FANOUT_RETRY_WINDOW_SECONDS:-8}"
RETRY_BACKOFF_SECONDS="${FANOUT_RETRY_BACKOFF_SECONDS:-1}"

mkdir -p "$SHARED_DIR"
: > "$PID_FILE"
echo "{\"live\":true,\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"destinations\":[]}" > "$STATUS_FILE"

if [ ! -f "$DEST_FILE" ]; then
  echo "fanout: no destinations file for $INGEST_KEY yet ($DEST_FILE) - only passthrough happens until one is armed"
  exit 0
fi

# Pushes one destination, retrying a handful of times if ffmpeg dies within
# RETRY_WINDOW_SECONDS of starting. Root cause: this self-read
# (`ffmpeg -i rtmp://localhost:1935/<path>`) starts reading the
# just-published stream from nearly its first byte, moments after
# MediaMTX's runOnReady hook fires - the H.264 SPS/PPS extradata isn't
# always available yet, so the demuxer gives up and the push dies a few
# seconds in with a broken pipe even with -analyzeduration/-probesize
# raised. That's a transient startup race, not a real end of stream, so
# it's worth one more try rather than silently dropping the destination
# for the rest of the broadcast. A push that ran longer than the window
# before dying is assumed to be a legitimate stream end (source stopped
# publishing) and is not retried. The TERM/INT trap makes sure
# fanout-stop.sh killing this function's pid (recorded in PID_FILE below)
# stops the retry loop immediately instead of respawning ffmpeg after an
# intentional stop.
push_one() {
  platform="$1"
  label="$2"
  target="$3"
  log_file="$SHARED_DIR/${INGEST_KEY}.${platform}.log"
  attempt=0
  stopping=0
  child_pid=""
  trap 'stopping=1; [ -n "$child_pid" ] && kill "$child_pid" 2>/dev/null || true' TERM INT

  while [ "$attempt" -lt "$MAX_RETRIES" ] && [ "$stopping" -eq 0 ]; do
    attempt=$((attempt + 1))
    echo "fanout: pushing $MTX_PATH -> $platform ($label), attempt $attempt/$MAX_RETRIES" >>"$log_file"
    start_ts=$(date +%s)
    ffmpeg -nostdin -loglevel warning -analyzeduration 2000000 -probesize 2000000 \
      -re -i "$SOURCE_URL" -c copy -f flv "$target" \
      >>"$log_file" 2>&1 &
    child_pid=$!
    if wait "$child_pid"; then
      status=0
    else
      status=$?
    fi
    child_pid=""
    [ "$stopping" -eq 1 ] && break
    [ "$status" -eq 0 ] && break
    elapsed=$(($(date +%s) - start_ts))
    if [ "$elapsed" -ge "$RETRY_WINDOW_SECONDS" ]; then
      echo "fanout: $platform push ended after ${elapsed}s - treated as a real stream end, not retrying" >>"$log_file"
      break
    fi
    if [ "$attempt" -ge "$MAX_RETRIES" ]; then
      echo "fanout: $platform push failed after $attempt attempts within ${elapsed}s each, giving up" >>"$log_file"
      break
    fi
    echo "fanout: $platform push died after ${elapsed}s (attempt $attempt/$MAX_RETRIES) - retrying in ${RETRY_BACKOFF_SECONDS}s" >>"$log_file"
    sleep "$RETRY_BACKOFF_SECONDS"
  done
}

names=""
sep=""
while IFS='|' read -r platform label target; do
  [ -z "$platform" ] && continue
  push_one "$platform" "$label" "$target" &
  echo "$!" >> "$PID_FILE"
  names="${names}${sep}\"${platform}\""
  sep=","
done < "$DEST_FILE"

echo "{\"live\":true,\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"destinations\":[${names}]}" > "$STATUS_FILE"

# runOnReady must stay in the foreground for MediaMTX to track the hook's
# lifetime; wait on the background ffmpeg jobs we just started.
wait
