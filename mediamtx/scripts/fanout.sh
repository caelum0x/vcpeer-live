#!/bin/sh
# Runs when a path under live/<ingestKey> gets its first publisher
# (MediaMTX's runOnAvailable hook). Reads the control app's destinations
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
echo "{\"live\":true,\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$STATUS_FILE"

if [ ! -f "$DEST_FILE" ]; then
  echo "fanout: no destinations file for $INGEST_KEY yet ($DEST_FILE) - only passthrough happens until one is armed"
  exit 0
fi

# Pushes one destination, retrying a handful of times if ffmpeg dies within
# RETRY_WINDOW_SECONDS of starting. Root cause: this self-read
# (`ffmpeg -i rtmp://localhost:1935/<path>`) starts reading the
# just-published stream from nearly its first byte, moments after
# MediaMTX's runOnAvailable hook fires - the H.264 SPS/PPS extradata isn't
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
#
# Each destination also gets its own `<ingestKey>.<id>.state` JSON file,
# rewritten on every state transition (pushing/retrying/failed/stopped),
# so the control app's GET /api/live/status can tell a broadcaster which
# specific platform stopped receiving instead of only "Live"/"Offline"
# for the whole broadcast. Keyed by `id` (not `platform`) because a user
# can have two destinations on the same platform - `id` is the only
# field guaranteed unique per line of $DEST_FILE.
write_state() {
  state_file="$SHARED_DIR/${INGEST_KEY}.${id}.state"
  err_json="null"
  if [ -n "${3:-}" ]; then
    err_escaped=$(printf '%s' "$3" | tr -d '\n' | sed 's/\\/\\\\/g; s/"/\\"/g')
    err_json="\"$err_escaped\""
  fi
  cat > "$state_file" <<EOF
{"id":"$id","platform":"$platform","label":"$label","state":"$1","attempt":$2,"lastError":$err_json,"updatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
}

push_one() {
  id="$1"
  platform="$2"
  label="$3"
  target="$4"
  log_file="$SHARED_DIR/${INGEST_KEY}.${id}.log"
  attempt=0
  stopping=0
  child_pid=""
  trap 'stopping=1; [ -n "$child_pid" ] && kill "$child_pid" 2>/dev/null || true' TERM INT

  while [ "$stopping" -eq 0 ]; do
    attempt=$((attempt + 1))
    write_state "pushing" "$attempt"
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
    if [ "$stopping" -eq 1 ]; then
      write_state "stopped" "$attempt" "stopped: source ended"
      break
    fi
    if [ "$status" -eq 0 ]; then
      write_state "stopped" "$attempt" ""
      break
    fi
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
      write_state "retrying" "$attempt" "mid-stream drop after ${elapsed}s, reconnecting"
      attempt=0
      sleep "$RETRY_BACKOFF_SECONDS"
      continue
    fi
    if [ "$attempt" -ge "$MAX_RETRIES" ]; then
      echo "fanout: $platform push failed after $attempt attempts within ${elapsed}s each, giving up" >>"$log_file"
      write_state "failed" "$attempt" "failed after $attempt attempts within ${elapsed}s each"
      break
    fi
    echo "fanout: $platform push died after ${elapsed}s (attempt $attempt/$MAX_RETRIES) - retrying in ${RETRY_BACKOFF_SECONDS}s" >>"$log_file"
    write_state "retrying" "$attempt" "died after ${elapsed}s, retrying in ${RETRY_BACKOFF_SECONDS}s"
    sleep "$RETRY_BACKOFF_SECONDS"
  done
}

while IFS='|' read -r id platform label target; do
  [ -z "$id" ] && continue
  push_one "$id" "$platform" "$label" "$target" &
  echo "$!" >> "$PID_FILE"
done < "$DEST_FILE"

# VOD recording (Pro-only - the control app only writes this flag file
# for a Pro owner, see control/src/lib/live.js writeRecordFlag). Its
# content is the broadcast id, written moments before this hook fires by
# the SAME POST /api/live/go request that wrote $DEST_FILE above, so a
# recording's filename maps straight back to a broadcast-history row with
# no extra bookkeeping. A fresh, never-before-used SEGMENT file every
# time this leg (re)starts - on the SPS/PPS startup race or a mid-stream
# network blip alike - so a transient failure can never truncate or
# corrupt bytes already written for this broadcast; multiple segments
# for one broadcast is the deliberate, safe outcome of that choice.
RECORD_FILE="$SHARED_DIR/${INGEST_KEY}.record"
if [ -f "$RECORD_FILE" ]; then
  BROADCAST_ID=$(cat "$RECORD_FILE")
  VOD_DIR="$SHARED_DIR/vods/${INGEST_KEY}"
  mkdir -p "$VOD_DIR"
  record_one() {
    seg=0
    attempt=0
    stopping=0
    child_pid=""
    log_file="$SHARED_DIR/${INGEST_KEY}.vod.log"
    state_file="$SHARED_DIR/${INGEST_KEY}.vod.state"
    trap 'stopping=1; [ -n "$child_pid" ] && kill "$child_pid" 2>/dev/null || true' TERM INT
    while [ "$stopping" -eq 0 ]; do
      seg=$((seg + 1))
      attempt=$((attempt + 1))
      out_file="$VOD_DIR/${BROADCAST_ID}.${seg}.mp4"
      echo "{\"id\":\"vod\",\"state\":\"recording\",\"segment\":$seg,\"updatedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$state_file"
      echo "fanout: recording $MTX_PATH -> $out_file, attempt $attempt/$MAX_RETRIES" >>"$log_file"
      start_ts=$(date +%s)
      # Fragmented MP4 (frag_keyframe+empty_moov), NOT +faststart, PLUS
      # -flush_packets 1. A broadcast is normally ended by killing this
      # process with TERM (fanout-stop.sh, when the source disconnects) -
      # verified live against a real recording that +faststart's single
      # trailer rewrite at the very end NEVER completes on a signal-
      # driven stop: ffmpeg's own signal handler aborts av_write_trailer()
      # the same way it aborts the read loop, so every TERM'd recording
      # came out truncated with no moov atom at all (0:00 runtime,
      # unplayable). Fragmented MP4 writes a self-contained moof/mdat
      # pair per keyframe GOP instead of one trailer at the end - but
      # also verified live that frag_keyframe ALONE still isn't enough:
      # ffmpeg's own avio buffer holds each finished fragment in memory
      # rather than writing it to disk immediately, so a kill between
      # fragments still lost everything (observed a consistent 0-48 byte
      # file, several keyframe intervals in, with only frag_keyframe).
      # -flush_packets 1 forces every fragment to hit disk as soon as
      # it's muxed - confirmed live by `kill -TERM` mid-recording then
      # `ffmpeg -f null -i` decoding the result cleanly with no errors.
      ffmpeg -nostdin -loglevel warning -analyzeduration 2000000 -probesize 2000000 \
        -re -i "$SOURCE_URL" -map 0 -c copy \
        -movflags +frag_keyframe+empty_moov+default_base_moof -flush_packets 1 "$out_file" \
        >>"$log_file" 2>&1 &
      child_pid=$!
      if wait "$child_pid"; then
        status=0
      else
        status=$?
      fi
      child_pid=""
      if [ "$stopping" -eq 1 ]; then
        break
      fi
      if [ "$status" -eq 0 ]; then
        break
      fi
      elapsed=$(($(date +%s) - start_ts))
      if [ "$elapsed" -ge "$RETRY_WINDOW_SECONDS" ]; then
        # Recorded stably for a while before dying - a real mid-stream
        # drop, not the startup race. Start a NEW segment (never reopen
        # $out_file) and give it a fresh retry budget, same reasoning as
        # push_one's mid-stream-drop branch above.
        echo "fanout: recording ended after ${elapsed}s - mid-stream drop, starting a new segment" >>"$log_file"
        attempt=0
        sleep "$RETRY_BACKOFF_SECONDS"
        continue
      fi
      if [ "$attempt" -ge "$MAX_RETRIES" ]; then
        echo "fanout: recording failed after $attempt attempts within ${elapsed}s each, giving up for this broadcast" >>"$log_file"
        break
      fi
      echo "fanout: recording died after ${elapsed}s (attempt $attempt/$MAX_RETRIES) - retrying in ${RETRY_BACKOFF_SECONDS}s" >>"$log_file"
      sleep "$RETRY_BACKOFF_SECONDS"
    done
    echo "{\"id\":\"vod\",\"state\":\"stopped\",\"segment\":$seg,\"updatedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$state_file"
  }
  record_one &
  echo "$!" >> "$PID_FILE"
fi

echo "{\"live\":true,\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$STATUS_FILE"

# runOnAvailable must stay in the foreground for MediaMTX to track the hook's
# lifetime; wait on the background ffmpeg jobs we just started.
wait
