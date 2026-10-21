# VCPeer Live — owner-only blockers / notes

## Deploy blocker (owner-only, 2026-10-21)

`deploy/RUNBOOK.md` ("Target box") already documents this, restated here so
it's not missed: VCPeer Live needs a **new Oracle Ampere A1 (ARM) box** — the
existing `vcpeer` E2.1.Micro box is explicitly undersized for this service,
and the service also needs raw TCP port 1935 (RTMP ingest) opened directly
on a box's public IP/security list, which a Cloudflare Tunnel cannot do.
Provisioning a new box and opening that port is a genuine new-infrastructure
decision — owner-only. Not done in this pass; spent the session on real
code work in `control/` instead so there's more ready to ship once the box
exists.

## VCPeer Book cross-link gap (not fixed, disproportionate to fix)

`vcpeer-book` (Cal.com/cal.diy self-host, env/theming-only branding per
`branding/README.md`) has no footer or public page we can add a "VCPeer
Live" cross-link to without forking cal.diy source — which the branding
doc explicitly says to avoid unless branding needs go beyond env/theming.
`vcpeer` (core) and `vcpeer-share` already link out to Live; `vcpeer-live`
links back to all three. Leaving `vcpeer-book` without a reciprocal link
is a minor, low-value gap not worth forking a monorepo to close.
