# VCPeer Live

Free multistream: go live once, broadcast to Twitch, Kick and YouTube at
the same time, plus a watch page with chat at vcpeer.com. No per-platform
re-encode - straight passthrough fan-out. No OBS required - go live from
the browser too.

Composed from off-the-shelf OSS, not hand-written:
- [Owncast](https://github.com/owncast/owncast) (MIT) - watch page, chat,
  HLS passthrough.
- [MediaMTX](https://github.com/bluenviron/mediamtx) (MIT) - RTMP/WHIP
  ingest and fan-out to user-provided RTMP(S) destinations.
- `control/` - the only new code in this repo: a small Express app for
  sign-in (magic link), destination management (encrypted stream keys),
  live credentials, and arming the fan-out.

## Quick start (local)

```
cp .env.example .env
# fill in ENCRYPTION_KEY: openssl rand -hex 32
COMPOSE_PROFILES=proof docker-compose up -d --build
```

`COMPOSE_PROFILES=proof` additionally starts a second MediaMTX instance
standing in for Twitch/Kick, so you can prove the whole fan-out locally
without touching real streaming accounts. Drop it for production - see
`deploy/RUNBOOK.md`.

- Control UI: http://localhost:4000
- Owncast watch page: http://localhost:8080
- MediaMTX RTMP ingest: `rtmp://localhost:1935`
- MediaMTX WHIP ingest (browser go-live): `http://localhost:8889`

## Tests

```
cd control && npm install && npm test
```

## Deploy

See `deploy/RUNBOOK.md` - target box, the RTMP/WHIP port-opening steps a
Cloudflare Tunnel cannot do, smoke tests, and rollback.
