# VCPeer Live — owner-only blockers / notes

## RESOLVED 2026-10-22: production was live but badly stale, and sign-in was 100% broken

Earlier versions of this file (and `deploy/RUNBOOK.md`'s "Steps ... not run
this session" framing) said VCPeer Live had never been deployed and was
blocked on a new Oracle box. That was wrong - it has been live since
2026-10-15 on the existing `box` (130.61.180.42, Oracle Ampere A1, not the
undersized E2.1.Micro the old note warned about) at `live.vcpeer.com` /
`watch.vcpeer.com`, RTMP 1935 + WHIP 8889/8189 open in both ufw and the OCI
Security List. Confirmed live and externally reachable again on 2026-10-22.

Two real problems found and fixed live on 2026-10-22, in order of severity:

1. **Sign-in was completely broken for every real user** - `POST
   /api/auth/request-link` returned `502`/`send_failed` for 100% of
   requests. Root cause: Oracle Cloud Email Delivery's approved-senders
   list for the `vcpeer.com` domain had `send@`, `support@`, and `no-reply@`
   approved, but not `live@vcpeer.com` (the `SMTP_FROM` this app actually
   uses) - `535 Authorization failed: Envelope From address
   <live@vcpeer.com> not authorized`. Fixed by calling
   `EmailClient.create_sender(email_address="live@vcpeer.com")` via the OCI
   Python SDK (same credentials/method as
   `oci-security-list-api-not-console-only-2026-10-15`) - took effect
   immediately, no deploy needed. Verified end-to-end: real
   `request-link` -> real email delivered to the inbox from `live@vcpeer.com`
   -> real callback -> session cookie -> `/api/live/credentials` ->
   `/api/live/go` -> a real `ffmpeg` RTMP push to the live ingest -> Owncast
   `online: true` and `GET /hls/stream.m3u8` -> 200, all on production.
   The 2026-10-17 fix that made this failure surface as an honest 502
   instead of a silent "check your email" lie (`2ca66d3`) is exactly what
   made this diagnosable from the outside instead of looking like nothing
   was wrong.

2. **Production was running the 2026-10-16 build of `control/` and
   `mediamtx/scripts/fanout.sh`**, missing every fix merged to `main` since
   then: the nodemailer SMTP-injection CVE fix (`bd88ab4`), magic-link
   rate limiting (`a8fb7d0`), real session revocation on logout
   (`a260a9e`), ingest-key rotation (`e5f3914`), re-arm-on-destination-change
   (`002b513`), the landing page's `robots.txt`/`sitemap.xml`/OG tags
   (`251a5d1`), the vcpeer.com/Send/Book cross-links (`1f37a37`), and the
   mid-stream fanout self-read race fix (`d43fcef`, merged hours before
   this redeploy). Redeployed by rsyncing `control/{src,public,package.json,
   package-lock.json,Dockerfile}` and `mediamtx/scripts/fanout.sh` from this
   repo's `main` into `/opt/infra-box/stacks/vcpeer-live` on `box`, rebuilding
   with `docker compose --env-file /etc/products/vcpeer-live.env build
   control mediamtx`, and recreating both containers. Pre-redeploy files
   backed up to `/opt/infra-box/backups/vcpeer-live-pre-redeploy-20261022/`
   on the box. Verified live: `nodemailer` in the rebuilt container is
   `10.1.7`; `/robots.txt` and `/sitemap.xml` now 200 (were 404); footer
   cross-links present; the magic-link rate limiter now returns `429` on
   the 6th rapid request for the same email (verified against production
   with a disposable test address, not a real inbox).

**This repo has no deploy automation and no `.git` checkout on the box** -
every past deploy (including this one) was a manual rsync + rebuild, which
is exactly how it silently drifted 6 days out of date. A real follow-up
(not done here, genuinely new scope): either a small deploy script in this
repo (`deploy/redeploy.sh` - rsync + `docker compose build/up` for `box`)
or a periodic drift check comparing the box's running `control/src` against
`origin/main`, so the next set of merged fixes doesn't sit undeployed again.

## VCPeer Book cross-link gap (not fixed, disproportionate to fix)

`vcpeer-book` (Cal.com/cal.diy self-host, env/theming-only branding per
`branding/README.md`) has no footer or public page we can add a "VCPeer
Live" cross-link to without forking cal.diy source — which the branding
doc explicitly says to avoid unless branding needs go beyond env/theming.
`vcpeer` (core) and `vcpeer-share` already link out to Live; `vcpeer-live`
links back to all three. Leaving `vcpeer-book` without a reciprocal link
is a minor, low-value gap not worth forking a monorepo to close.
