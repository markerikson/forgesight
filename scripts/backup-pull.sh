#!/usr/bin/env bash
# Copies the server's database backups to this machine.
# Usage: bash scripts/backup-pull.sh [dest]   (default: ~/forgesight-backups/)
# Reads DEPLOY_SERVER and DEPLOY_DIR like scripts/deploy.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .deploy.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .deploy.env
  set +a
fi

DEPLOY_SERVER="${DEPLOY_SERVER:?Set DEPLOY_SERVER (env or .deploy.env)}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/forgesight}"
dest="${1:-$HOME/forgesight-backups/}"

mkdir -p "$dest"
rsync_flags=(-az)
case "$(uname -s)" in
  MINGW* | MSYS*) rsync_flags+=(--protocol=32) ;;
esac
rsync "${rsync_flags[@]}" "$DEPLOY_SERVER:$DEPLOY_DIR/data/backups/" "$dest"
ls -lt "$dest" | head -n 6
