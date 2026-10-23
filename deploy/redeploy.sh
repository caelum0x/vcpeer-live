#!/usr/bin/env bash
# VCPeer Live - manual redeploy to `box`.
#
# Not CI/CD, not a GitHub Actions workflow - a plain shell script you run
# by hand from a checkout of this repo whenever main has fixes/features
# that haven't shipped yet. Exists because this repo has no deploy
# automation and no `.git` checkout on the box itself (see NOTES.md,
# 2026-10-22): every past deploy was a manual rsync + rebuild typed by
# hand, which is exactly how production silently drifted 6 days stale
# with 8 merged fixes sitting undeployed. This script is that same manual
# sequence, written down once, so it's repeatable and diffable instead of
# re-derived from memory each time.
#
# `$BOX_PATH` is root-owned on `box` (from an earlier manual `sudo`
# rsync - see NOTES.md, 2026-10-24) while the SSH key this script uses
# logs in as an unprivileged `deploy` user, so every file write below
# goes rsync-to-a-deploy-owned-staging-dir, then `ssh ... sudo cp -r`
# into place - a direct `rsync ... "$BOX_HOST:$BOX_PATH/..."` here hits
# `Permission denied` (confirmed 2026-10-24). `docker compose` itself
# does NOT need sudo (the deploy user is in the `docker` group) and the
# root-owned tree is world-readable, so only the two `cp`/`mkdir` steps
# below need it.
#
# Usage:
#   deploy/redeploy.sh              # rsync + rebuild + restart everything
#   deploy/redeploy.sh control      # only the control app (fast path)
#   deploy/redeploy.sh mediamtx     # only mediamtx (fanout script changes)
#   deploy/redeploy.sh --dry-run    # show what would run, change nothing
#
# Override the target via env vars if the box ever changes:
#   BOX_HOST=root@130.61.180.42 BOX_PATH=/opt/infra-box/stacks/vcpeer-live \
#     deploy/redeploy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOX_HOST="${BOX_HOST:-box}"                                        # SSH alias/host for 130.61.180.42 (Oracle Ampere A1) - see deploy/RUNBOOK.md
BOX_PATH="${BOX_PATH:-/opt/infra-box/stacks/vcpeer-live}"
ENV_FILE="${ENV_FILE:-/etc/products/vcpeer-live.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/infra-box/backups}"
TARGET="${1:-all}"
DRY_RUN=0
if [ "$TARGET" = "--dry-run" ]; then
  DRY_RUN=1
  TARGET="all"
fi
if [ "${2:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ $*"
  else
    echo "+ $*"
    "$@"
  fi
}

echo "vcpeer-live redeploy: target=$TARGET box=$BOX_HOST path=$BOX_PATH dry_run=$DRY_RUN"

TS="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/vcpeer-live-pre-redeploy-$TS"
STAGING_DIR="/tmp/vcpeer-live-redeploy-staging-$TS"

run ssh "$BOX_HOST" "mkdir -p '$STAGING_DIR'"

# docker-compose.yml itself (e.g. a new env var added to a service's
# `environment:` block) was never synced by this script before
# 2026-10-24 - a compose-file-only change would silently never reach
# `box` no matter how many times you ran this. Always sync it,
# regardless of target, since it affects every service's container.
run rsync -az "$REPO_ROOT/docker-compose.yml" "$BOX_HOST:$STAGING_DIR/docker-compose.yml"
run ssh "$BOX_HOST" "sudo cp '$STAGING_DIR/docker-compose.yml' '$BOX_PATH/docker-compose.yml' && sudo chown root:root '$BOX_PATH/docker-compose.yml'"

case "$TARGET" in
  all|control)
    run ssh "$BOX_HOST" "sudo mkdir -p '$BACKUP_DIR/control' && sudo cp -r '$BOX_PATH/control/src' '$BOX_PATH/control/public' '$BACKUP_DIR/control/' 2>/dev/null || true"
    run ssh "$BOX_HOST" "mkdir -p '$STAGING_DIR/control-extra'"
    run rsync -az "$REPO_ROOT/control/src/" "$BOX_HOST:$STAGING_DIR/control-src/"
    run rsync -az "$REPO_ROOT/control/public/" "$BOX_HOST:$STAGING_DIR/control-public/"
    run rsync -az \
      "$REPO_ROOT/control/package.json" "$REPO_ROOT/control/package-lock.json" "$REPO_ROOT/control/Dockerfile" \
      "$BOX_HOST:$STAGING_DIR/control-extra/"
    run ssh "$BOX_HOST" "sudo rsync -a --delete '$STAGING_DIR/control-src/' '$BOX_PATH/control/src/' && \
      sudo rsync -a --delete '$STAGING_DIR/control-public/' '$BOX_PATH/control/public/' && \
      sudo cp '$STAGING_DIR/control-extra/package.json' '$STAGING_DIR/control-extra/package-lock.json' '$STAGING_DIR/control-extra/Dockerfile' '$BOX_PATH/control/' && \
      sudo chown -R root:root '$BOX_PATH/control'"
    ;;
esac

case "$TARGET" in
  all|mediamtx)
    run ssh "$BOX_HOST" "sudo mkdir -p '$BACKUP_DIR/mediamtx' && sudo cp -r '$BOX_PATH/mediamtx/scripts' '$BACKUP_DIR/mediamtx/' 2>/dev/null || true"
    run ssh "$BOX_HOST" "mkdir -p '$STAGING_DIR/mediamtx-extra'"
    run rsync -az "$REPO_ROOT/mediamtx/scripts/" "$BOX_HOST:$STAGING_DIR/mediamtx-scripts/"
    run rsync -az \
      "$REPO_ROOT/mediamtx/mediamtx.yml" "$REPO_ROOT/mediamtx/Dockerfile" \
      "$BOX_HOST:$STAGING_DIR/mediamtx-extra/"
    run ssh "$BOX_HOST" "sudo rsync -a --delete '$STAGING_DIR/mediamtx-scripts/' '$BOX_PATH/mediamtx/scripts/' && \
      sudo cp '$STAGING_DIR/mediamtx-extra/mediamtx.yml' '$STAGING_DIR/mediamtx-extra/Dockerfile' '$BOX_PATH/mediamtx/' && \
      sudo chown -R root:root '$BOX_PATH/mediamtx'"
    ;;
esac

run ssh "$BOX_HOST" "rm -rf '$STAGING_DIR'"

BUILD_SERVICES=""
case "$TARGET" in
  all) BUILD_SERVICES="control mediamtx" ;;
  control) BUILD_SERVICES="control" ;;
  mediamtx) BUILD_SERVICES="mediamtx" ;;
  *)
    echo "unknown target: $TARGET (expected: all, control, mediamtx, or --dry-run)" >&2
    exit 1
    ;;
esac

run ssh "$BOX_HOST" "cd '$BOX_PATH' && docker compose --env-file '$ENV_FILE' build $BUILD_SERVICES"
run ssh "$BOX_HOST" "cd '$BOX_PATH' && docker compose --env-file '$ENV_FILE' up -d $BUILD_SERVICES"

echo
echo "Rebuilt and restarted: $BUILD_SERVICES"
echo "Pre-deploy backup (if services pre-existed): $BACKUP_DIR (on $BOX_HOST)"
echo
echo "Smoke test:"
echo "  curl -sI https://live.vcpeer.com/healthz"
echo "  ssh $BOX_HOST \"cd '$BOX_PATH' && docker compose ps\""
echo "  ssh $BOX_HOST \"cd '$BOX_PATH' && docker compose logs --tail=50 control\""
