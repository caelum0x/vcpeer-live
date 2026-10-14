# VCPeer Live - deploy runbook

Everything in this directory and the repo root was **built and proven locally
only**. No server, DNS, or production change was made in this session (hard
limit, per the brief). This is the exact runbook for the owner-approved
deploy session.

## What this is

Free multistream: a streamer goes live once (OBS or straight from the
browser, no OBS needed) and VCPeer Live fans that single stream out to
Twitch, Kick, YouTube, or any custom RTMP(S) destination - with no
transcoding, straight passthrough re-mux. Every stream also gets a watch
page with live chat at vcpeer.com, served by the same pipeline.

Composed from off-the-shelf OSS, not hand-written:
- **Owncast** (`owncast/owncast`, MIT) - watch page, chat, HLS passthrough.
- **MediaMTX** (`bluenviron/mediamtx`, MIT) - RTMP/WHIP ingest and fan-out
  to user-provided RTMP(S) destinations via its own `runOnAvailable` hook
  mechanism (we only wrote the ~30-line shell script the hook runs).
- **Control app** (this repo's only new code, `control/`) - sign-in,
  destinations CRUD with encrypted stream keys, credentials, go-live,
  status. Plain Express + a JSON-file store, no new database to run.

## Local proof (what was actually run and verified this session)

```
cd ~/products/vcpeer-live
cp .env.example .env
# fill ENCRYPTION_KEY: openssl rand -hex 32
COMPOSE_PROFILES=proof docker-compose up -d --build
```

`COMPOSE_PROFILES=proof` additionally starts `mediamtx-fake`, a second,
unmodified MediaMTX instance standing in for Twitch/Kick so the fan-out can
be proven end-to-end without touching real accounts. **Never use the `proof`
profile in production** - plain `docker-compose up -d --build` (no
`COMPOSE_PROFILES`) starts only `owncast`, `owncast-init`, `mediamtx`, and
`control`.

Verified this session, in order:
1. `docker-compose ps` - all 4 real services (`owncast`, `owncast-init`,
   `mediamtx`, `control`) up; `owncast` healthy.
2. `owncast-init` logs: `stream output variants updated` / `changed` - a
   single `source` passthrough video variant (no transcoding) and the
   shared Owncast stream key were set via Owncast's own admin REST API
   (`POST /api/admin/config/video/streamoutputvariants`,
   `POST /api/admin/config/streamkeys`, HTTP Basic `admin`/`abc123` by
   default - **change `OWNCAST_ADMIN_PASSWORD` before any public deploy**).
3. Control app flow via curl: `POST /api/auth/request-link` ->
   `GET /api/auth/callback?token=...` (dev mode echoes the link back in the
   JSON response since no SMTP is configured locally) -> session cookie ->
   `POST /api/destinations` x2 (pointed at `mediamtx-fake`, masked key
   confirmed never includes the plaintext) -> `GET /api/live/credentials`
   (ingest RTMP URL + WHIP URL) -> `POST /api/live/go` (writes the
   pipe-delimited fan-out file to the shared volume, decrypted key only
   in-memory and only in that gitignored runtime file).
4. Pushed a real `ffmpeg -re -f lavfi testsrc`+`sine` stream via RTMP to
   `rtmp://localhost:1935/live/<ingestKey>`.
5. MediaMTX logs: `runOnAvailable command started` -> `fanout: pushing ...
   -> owncast`, `-> custom (Fake Twitch)`, `-> custom (Fake Kick)`.
6. `mediamtx-fake` logs: `stream is available and online` on both
   `twitch/<key>` and `kick/<key>` paths - **proof the fan-out actually
   reaches a second, independent server**, not just a loopback.
7. Owncast: `GET /api/status` -> `"online": true`; `GET /hls/stream.m3u8`
   -> 200. Dogfooded in a real browser (Playwright) - the watch page shows
   the live testsrc pattern and the default chat welcome message.
8. Resilience check: recreated the `mediamtx` container mid-stream (as a
   `docker-compose up --build` for an unrelated change would), restarted
   the ffmpeg push - the previously armed destinations file survived in
   the `fanout-shared` named volume and the fan-out re-armed automatically
   on reconnect with zero control-app calls needed.
9. Control app test suite: `cd control && npm test` - 31/31 passing
   (crypto round-trip + tamper/auth-tag rejection, destination validation,
   magic-link lifecycle incl. reuse/expiry, and an HTTP integration suite
   that never returns a plaintext stream key).
10. Screenshots at 1440x900 and 390x844 of `/`, `/live` (signed in, live
    status green), and the Owncast watch page - reviewed, one real issue
    found and fixed (credential row truncated the RTMP URL on mobile - now
    wraps full width) before this runbook was written.

## Target box

Same box family as the rest of the VCPeer/Oracle fleet - see
`~/products/vcpeer/deploy/README.md` for the sibling MiroTalk deploy on
Oracle E2.1.Micro ARM. Use an **Oracle Ampere A1 (ARM) box**, not the
E2.1.Micro - Owncast + MediaMTX + ffmpeg fan-out pushes need more than
956MB RAM, especially with 2+ simultaneous RTMP destinations per active
streamer. Both `owncast/owncast` and `bluenviron/mediamtx` ship official
multi-arch images including `linux/arm64`, confirmed by this session's
local pulls (Apple Silicon / arm64) - no emulation needed on an Ampere box.

## Steps (not run this session - owner-approved deploy only)

1. **Clone and configure:**
   ```
   git clone https://github.com/caelum0x/vcpeer-live.git
   cd vcpeer-live
   cp .env.example .env
   ```
   Fill in:
   - `ENCRYPTION_KEY` - `openssl rand -hex 32`. Encrypts every destination's
     stream key at rest (AES-256-GCM). Losing it makes stored destinations
     unrecoverable.
   - `PUBLIC_URL`, `RTMP_PUBLIC_URL`, `WHIP_PUBLIC_URL`, `OWNCAST_PUBLIC_URL`
     - the real `https://live.vcpeer.com` / `rtmp://live.vcpeer.com:1935` /
       etc. (see "Domain" below).
   - `OWNCAST_ADMIN_PASSWORD` - change from the `abc123` default.
   - `SMTP_HOST=mail.scribase.com` + `SMTP_USER`/`SMTP_PASS` (Scribase Mail
     SMTP credentials) so magic-link sign-in actually emails instead of
     falling back to the dev-mode echoed link. Set `VCPEER_LIVE_ENV=production`
     once SMTP is live so the dev-link fallback is disabled.

2. **Open the RTMP port - this is the one step a Cloudflare Tunnel cannot
   do.** Cloudflare Tunnel only proxies HTTP(S)/WebSocket; it cannot carry
   raw RTMP (TCP 1935) or the WHIP media's UDP/ICE traffic. Two pieces:
   - **RTMP (OBS ingest), TCP 1935**: open directly on the Oracle box's
     security list/NSG (Oracle Cloud -> Networking -> Virtual Cloud Network
     -> Security Lists -> add ingress rule: source `0.0.0.0/0`, TCP,
     destination port 1935) and point an A record (or the box's public IP
     directly) at it - this traffic bypasses Cloudflare entirely, same
     pattern any RTMP-ingest SaaS uses.
   - **WHIP (browser go-live), HTTPS port 8889 + UDP/ICE 8189**: the HTTP
     POST/DELETE for WHIP signaling can go through Cloudflare like any other
     HTTPS route, but the actual WebRTC media (UDP, port 8189) cannot - open
     that UDP port directly too, same security-list pattern as above.
   - Owncast's HTTP web/API (8080) and the control app (4000) go behind
     Caddy + Cloudflare as normal, same as the sibling `vcpeer` MiroTalk
     deploy's `Caddyfile.vcpeer`.

3. **Domain:** suggested `live.vcpeer.com` (control app + Owncast watch
   page) with Caddy path-routing `/` and `/live` -> control app (port 4000),
   everything else (the actual watch page root paths Owncast serves) ->
   Owncast (port 8080). If path-routing conflicts arise (both apps serving
   `/`), use a dedicated subdomain for the watch page instead
   (`watch.vcpeer.com` -> Owncast, `live.vcpeer.com` -> control app) - same
   reasoning as the sibling VCPeer Send build's subdomain-not-subpath
   decision (see `~/products/plans/vcpeer.md`, "Send a link = adopted OSS").

4. **Start:**
   ```
   docker-compose up -d --build
   docker-compose ps   # all of owncast (healthy), owncast-init (exited 0), mediamtx, control up
   docker-compose logs owncast-init   # confirm passthrough variant + stream key were set
   curl -I http://localhost:4000/healthz   # 200 from the box itself
   ```

5. **Caddy:** add a site block routing `live.vcpeer.com` (and
   `watch.vcpeer.com` if using the subdomain split) to the container ports,
   merged into the box's existing Caddyfile - same pattern as
   `~/products/vcpeer/deploy/Caddyfile.vcpeer`. `caddy validate && caddy
   reload`.

6. **Smoke test** (`docker-compose` services + the box's public endpoints):
   - `GET https://live.vcpeer.com/healthz` -> `{"ok":true}`
   - `GET https://live.vcpeer.com/` -> landing/sign-in page, 200
   - Sign in via a real email, follow the Scribase Mail link, land on
     `/live`, see RTMP server + stream key credentials
   - Add a real-but-low-stakes destination (e.g. a disabled Twitch test
     channel), click "Arm destinations", push a short OBS test stream,
     confirm it's live on `https://watch.vcpeer.com` (or
     `live.vcpeer.com`'s Owncast route) with chat, and separately confirm
     it shows up on the Twitch dashboard
   - `GET /api/live/status` while live -> `{"live":true,...}`

## Rollback

No DB migration, no shared state outside the named Docker volumes.

```
docker-compose down          # stops owncast, mediamtx, control
# restore the pre-deploy Caddyfile (drop the live.vcpeer.com block)
caddy reload
```

`docker-compose down -v` additionally drops the named volumes
(`owncast-data`, `control-data`, `fanout-shared`) if a full reset is wanted
- do **not** run `-v` for a routine rollback, only a deliberate wipe, since
  that deletes every stored (encrypted) destination.

## Owner-only (not done this session, silent blockers for the next deploy)

- Oracle Ampere A1 box provisioning/selection if a new box is needed (the
  existing `vcpeer` E2.1.Micro box is undersized for this service -
  see "Target box" above).
- Security-list ingress rules for TCP 1935 and UDP 8189 (owner/infra
  console action, see step 2).
- DNS: `live.vcpeer.com` (+ `watch.vcpeer.com` if using the subdomain
  split) A/AAAA records.
- Scribase Mail SMTP credentials for `SMTP_USER`/`SMTP_PASS` in the real
  `.env` (placeholders only in `.env.example`).
- Changing `OWNCAST_ADMIN_PASSWORD` from the `abc123` default before the
  box is internet-facing.
- Actual production deploy (steps 1-6 above).

## Known limits (v1 scope, stated rather than silently skipped)

- One ingest key per signed-in user (not per-destination) - matches "go
  live once, broadcast everywhere," not a multi-stream-per-account layout.
- No per-destination bitrate control - fan-out is a straight `ffmpeg -c
  copy` remux, so every destination receives the same encode the streamer's
  OBS (or browser) sent. If a destination's ingest requires a different
  codec/bitrate than the others, that's a real follow-up (would need a
  `-c:v libx264` re-encode leg for that one destination, no longer pure
  passthrough), not built here.
- Live status in the control UI is a 5-second poll of a status file
  MediaMTX's hook writes, not a websocket push - fine at today's scale, a
  reasonable follow-up at higher concurrency.
- Browser go-live (WHIP) was proven at the signaling layer but not the
  full media path, and that gap is a local-environment limitation, not a
  code bug: a headless Chromium (Playwright, `--use-fake-device-for-media-
  stream`) successfully got a fake camera feed (screenshot:
  `/tmp/vcpeer-live-whip-browser-golive.png` - the preview `<video>` shows
  Chromium's green fake-device pattern with a live timecode, and the "Go
  live from browser" button correctly flips to "Stop browser broadcast"),
  POSTed the SDP offer to MediaMTX's WHIP endpoint, and got back a 201 +
  SDP answer (confirmed by the lack of any thrown error in
  `whip.js`'s `publish()`). MediaMTX's own log then shows `[WebRTC]
  session ... created`, followed ~10s later by `closed: deadline exceeded
  while waiting connection` - the ICE/DTLS media handshake over the
  published UDP port (8189) never completes. This reproduced even after
  setting `webrtcAdditionalHosts`/`MTX_WEBRTCADDITIONALHOSTS=127.0.0.1` so
  the advertised ICE candidate matches the host-mapped port; the remaining
  gap is UDP port-forwarding through colima's macOS-VM networking layer
  (Docker Desktop/colima's NAT'd UDP forwarding for bidirectional
  ICE/DTLS is a widely-documented limitation, unrelated to this app). On
  the real deploy target - a Linux box with MediaMTX's container using the
  host's real network path, no VM-NAT layer in between - this is expected
  to work the same way the RTMP (OBS) path already proved live end-to-end
  to all three destinations. Re-verify WHIP specifically during the first
  real deploy smoke test (step 6 below) before calling it done.

## Fork/upstream maintenance (standing follow-up)

Neither Owncast nor MediaMTX is forked - both run as unmodified upstream
images (`owncast/owncast:latest`, `bluenviron/mediamtx:latest-ffmpeg` built
with two added shell scripts + our yaml config via `mediamtx/Dockerfile`).
Periodically re-pull `latest` and re-run the local proof above before
rolling a new image to production.
