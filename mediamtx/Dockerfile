# Adopted OSS base: bluenviron/mediamtx's own ffmpeg-enabled image
# (official, multi-arch, includes arm64). We only add the two fan-out
# hook scripts - no ingest/relay logic is reimplemented.
FROM bluenviron/mediamtx:latest-ffmpeg

COPY scripts/fanout.sh /scripts/fanout.sh
COPY scripts/fanout-stop.sh /scripts/fanout-stop.sh
RUN chmod +x /scripts/fanout.sh /scripts/fanout-stop.sh
COPY mediamtx.yml /mediamtx.yml
