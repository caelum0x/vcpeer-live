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

# Retry tuning for push_one below. A push that dies within
# RETRY_WINDOW_SECONDS of starting is treated as the self-read probe race
# (not a real failure) and gets retried, counting against MAX_RETRIES so a
# destination that is genuinely unreachable (bad key, wrong URL) still
# gives up instead of crash-looping forever. A push that ran stably past
# the window before dying is treated as a one-off mid-stream drop (a
# network blip to that one destination) and gets a FRESH retry budget,
# not a hard stop - a true end of the source stream is signalled
# explicitly (TERM from fanout-stop.sh, see the `stopping` flag below),
# never inferred from timing, so it's safe to keep reconnecting a
# still-live broadcast's destinations indefinitely.
# MAX_RETRIES/RETRY_BACKOFF_SECONDS must together cover a worst-case
# keyframe interval: this self-read can only produce a valid copy once a
# full GOP (SPS/PPS + a keyframe) has been written and is readable again,
# and encoders are free to pick any keyframe interval - OBS/Twitch-style
# presets commonly use ~2s, but nothing stops a user's encoder from using
# 10s+. 8 attempts x ~2s backoff gives a ~16s quick-fail budget, enough
# for encoders with a keyframe interval well past the common case, while
# still giving up (rather than crash-looping forever) on a destination
# that is genuinely unreachable (bad key, wrong URL).
MAX_RETRIES="${FANOUT_MAX_RETRIES:-8}"
RETRY_WINDOW_SECONDS="${FANOUT_RETRY_WINDOW_SECONDS:-8}"
RETRY_BACKOFF_SECONDS="${FANOUT_RETRY_BACKOFF_SECONDS:-2}"

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

  while [ "$stopping" -eq 0 ]; do
    attempt=$((attempt + 1))
    echo "fanout: pushing $MTX_PATH -> $platform ($label), attempt $attempt/$MAX_RETRIES" >>"$log_file"
    start_ts=$(date +%s)
    # `-map 0` forces every stream the demuxer found (video + audio) into
    # the output, instead of ffmpeg's default auto-selection. Without it,
    # a video stream whose SPS/PPS hasn't arrived yet within
    # analyzeduration/probesize (the startup race, see above) is just
    # SILENTLY EXCLUDED from an unmapped copy - ffmpeg logs a warning and
    # keeps running, happily pushing an audio-only stream for the rest of
    # the broadcast with exit code 0 forever. That's worse than dying: the
    # existing retry loop below only fires on a non-zero exit, so a
    # destination whose receiver tolerates an audio-only FLV (unlike
    # Owncast, which drops the connection and lets the retry below fix
    # it) would silently go video-less for the whole stream with no error
    # anywhere. `-map 0` makes the same race a hard mux failure instead -
    # exactly the failure mode this loop already retries correctly.
    ffmpeg -nostdin -loglevel warning -analyzeduration 2000000 -probesize 2000000 \
      -re -i "$SOURCE_URL" -map 0 -c copy -f flv "$target" \
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
      # This push ran stably for a while before dying - a mid-stream drop
      # (network blip to this one destination, a platform-side hiccup),
      # not the SPS/PPS startup race this loop is also guarding against.
      # The source itself hasn't told us to stop - that comes via the
      # TERM trap from fanout-stop.sh when runOnUnavailable fires, and is
      # already handled by the `stopping` check above regardless of how
      # long this attempt ran. So a late failure is not evidence the
      # destination is unreachable (that's what consecutive *quick*
      # failures below are for) - it's worth a fresh full retry budget
      # rather than permanently dropping this one platform for the rest
      # of a broadcast that might otherwise run for hours.
      echo "fanout: $platform push ended after ${elapsed}s - mid-stream drop, reconnecting with a fresh retry budget" >>"$log_file"
      attempt=0
      sleep "$RETRY_BACKOFF_SECONDS"
      continue
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
