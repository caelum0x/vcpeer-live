#!/bin/sh
# One-shot init for Owncast: waits for the server to come up, then
# configures it for passthrough (no transcoding - MediaMTX already
# re-muxes, Owncast just serves HLS + chat) via Owncast's own admin
# REST API. Fails soft (warns, exits 0) so compose up never hangs if
# Owncast's API shape changes between versions - the owner can always
# finish this one-time step by hand in /admin.
set -u

HOST="${OWNCAST_HOST:-owncast:8080}"
USER="admin"
PASS="${OWNCAST_ADMIN_PASSWORD:-abc123}"
STREAM_KEY="${OWNCAST_STREAM_KEY:-abc123}"
LOGO_FILE="${OWNCAST_LOGO_FILE:-/logo.png}"

echo "owncast-init: waiting for $HOST ..."
i=0
until curl -sf -u "$USER:$PASS" "http://$HOST/api/admin/serverconfig" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "owncast-init: WARNING - owncast did not come up in time, skipping auto-config. Configure passthrough + stream key by hand at http://$HOST/admin."
    exit 0
  fi
  sleep 2
done

echo "owncast-init: setting a single passthrough video variant (no transcoding)"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d '{"value":[{"name":"source","videoPassthrough":true,"audioPassthrough":true,"videoBitrate":0,"audioBitrate":0,"framerate":0,"cpuUsageLevel":0}]}' \
  "http://$HOST/api/admin/config/video/streamoutputvariants" \
  || echo "owncast-init: WARNING - could not set passthrough variant, leaving Owncast defaults"

echo "owncast-init: setting stream key"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d "{\"value\":[{\"key\":\"$STREAM_KEY\",\"comment\":\"vcpeer-live fanout\"}]}" \
  "http://$HOST/api/admin/config/streamkeys" \
  || echo "owncast-init: WARNING - could not set stream key, using the server's existing default"

# Replace Owncast's own stock branding (name "New Owncast Server", a
# welcome blurb linking to owncast.online/owncast.directory, and a demo
# video from Owncast's CDN) with VCPeer Live branding. Without this the
# public watch page - which does get real traffic since it's linked from
# vcpeer.com - advertises the upstream OSS project instead of VCPeer.
echo "owncast-init: setting server name"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d '{"value":"VCPeer Live"}' \
  "http://$HOST/api/admin/config/name" \
  || echo "owncast-init: WARNING - could not set server name"

echo "owncast-init: setting server summary"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d '{"value":"Free multistream watch page - part of VCPeer (vcpeer.com): free video calls, file sharing, scheduling and live streaming."}' \
  "http://$HOST/api/admin/config/serversummary" \
  || echo "owncast-init: WARNING - could not set server summary"

echo "owncast-init: setting stream title"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d '{"value":"Live on VCPeer"}' \
  "http://$HOST/api/admin/config/streamtitle" \
  || echo "owncast-init: WARNING - could not set stream title"

echo "owncast-init: setting tags"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d '{"value":["vcpeer","multistream","live"]}' \
  "http://$HOST/api/admin/config/tags" \
  || echo "owncast-init: WARNING - could not set tags"

echo "owncast-init: setting social handles"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d '{"value":[{"platform":"website","url":"https://vcpeer.com"}]}' \
  "http://$HOST/api/admin/config/socialhandles" \
  || echo "owncast-init: WARNING - could not set social handles"

echo "owncast-init: setting offline message"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d '{"value":"This stream is offline right now. Go live free at https://vcpeer.com/live"}' \
  "http://$HOST/api/admin/config/offlinemessage" \
  || echo "owncast-init: WARNING - could not set offline message"

echo "owncast-init: replacing page content"
curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
  -d '{"value":"Watch page for VCPeer Live - free multistream to Twitch, Kick and YouTube at the same time, no OBS required. Go live free at https://vcpeer.com/live."}' \
  "http://$HOST/api/admin/config/pagecontent" \
  || echo "owncast-init: WARNING - could not set page content"

if [ -f "$LOGO_FILE" ]; then
  echo "owncast-init: setting logo"
  LOGO_B64=$(base64 "$LOGO_FILE" | tr -d '\n')
  curl -sf -u "$USER:$PASS" -X POST -H "Content-Type: application/json" \
    -d "{\"value\":\"data:image/png;base64,$LOGO_B64\"}" \
    "http://$HOST/api/admin/config/logo" \
    || echo "owncast-init: WARNING - could not set logo"
else
  echo "owncast-init: WARNING - $LOGO_FILE not found, leaving Owncast's default logo"
fi

echo "owncast-init: done"
