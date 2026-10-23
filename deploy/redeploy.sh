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

case "$TARGET" in
  all|control)
    run ssh "$BOX_HOST" "mkdir -p '$BACKUP_DIR/control' && cp -r '$BOX_PATH/control/src' '$BOX_PATH/control/public' '$BACKUP_DIR/control/' 2>/dev/null || true"
    run rsync -az --delete \
      "$REPO_ROOT/control/src/" "$BOX_HOST:$BOX_PATH/control/src/"
    run rsync -az --delete \
      "$REPO_ROOT/control/public/" "$BOX_HOST:$BOX_PATH/control/public/"
    run rsync -az \
      "$REPO_ROOT/control/package.json" "$REPO_ROOT/control/package-lock.json" "$REPO_ROOT/control/Dockerfile" \
      "$BOX_HOST:$BOX_PATH/control/"
    ;;
esac

case "$TARGET" in
  all|mediamtx)
    run ssh "$BOX_HOST" "mkdir -p '$BACKUP_DIR/mediamtx' && cp -r '$BOX_PATH/mediamtx/scripts' '$BACKUP_DIR/mediamtx/' 2>/dev/null || true"
    run rsync -az --delete \
      "$REPO_ROOT/mediamtx/scripts/" "$BOX_HOST:$BOX_PATH/mediamtx/scripts/"
    run rsync -az \
      "$REPO_ROOT/mediamtx/mediamtx.yml" "$REPO_ROOT/mediamtx/Dockerfile" \
      "$BOX_HOST:$BOX_PATH/mediamtx/"
    ;;
esac

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
