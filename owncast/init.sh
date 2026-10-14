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

echo "owncast-init: done"
