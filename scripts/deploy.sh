#!/usr/bin/env bash
# Builds locally and deploys to a server over ssh, running the worker and web app under pm2.
#
# Usage: bash scripts/deploy.sh [--sync-env] [--sync-config] [--skip-checks] [--allow-dirty]
#
# Settings come from the environment, or from a .deploy.env file in the repo root:
#   DEPLOY_SERVER       ssh destination, e.g. user@host or a Host alias (required)
#   DEPLOY_DIR          app directory on the server (default: /opt/forgesight)
#   DEPLOY_ENV_FILE     local file copied to $DEPLOY_DIR/.env by --sync-env (default: .env.production)
#   DEPLOY_CONFIG_FILE  local file copied to ~/.config/forgesight/config.jsonc on the server
#                       by --sync-config (required for --sync-config)
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
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-.env.production}"
DEPLOY_CONFIG_FILE="${DEPLOY_CONFIG_FILE:-}"
REMOTE_CONFIG_DIR=".config/forgesight"

sync_env=false
sync_config=false
skip_checks=false
allow_dirty=false
for arg in "$@"; do
  case "$arg" in
    --sync-env) sync_env=true ;;
    --sync-config) sync_config=true ;;
    --skip-checks) skip_checks=true ;;
    --allow-dirty) allow_dirty=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

# pm2 and node are only on PATH in a login shell (nvm).
remote() {
  ssh "$DEPLOY_SERVER" "bash -lc $(printf '%q' "cd $DEPLOY_DIR && $1")"
}

sha="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$allow_dirty" != true ]]; then
    echo "Working tree is dirty. Commit first, or pass --allow-dirty." >&2
    exit 1
  fi
  sha="$sha-dirty"
  short_sha="$short_sha-dirty"
fi

if [[ "$sync_env" == true && ! -f "$DEPLOY_ENV_FILE" ]]; then
  echo "--sync-env: $DEPLOY_ENV_FILE not found" >&2
  exit 1
fi
if [[ "$sync_config" == true && ! -f "$DEPLOY_CONFIG_FILE" ]]; then
  echo "--sync-config: set DEPLOY_CONFIG_FILE to an existing file (got '$DEPLOY_CONFIG_FILE')" >&2
  exit 1
fi

if [[ "$skip_checks" != true ]]; then
  step "Checks"
  bun run typecheck
  bun run lint
  bun run test
fi

step "Build $sha"
bun scripts/deploy-check.ts build-info "$sha"
bun run build

step "Prepare $DEPLOY_SERVER:$DEPLOY_DIR"
ssh "$DEPLOY_SERVER" "mkdir -p $DEPLOY_DIR/data/backups $DEPLOY_DIR/data/logs"

if [[ "$sync_env" == true ]]; then
  step "Sync $DEPLOY_ENV_FILE -> $DEPLOY_DIR/.env"
  ssh "$DEPLOY_SERVER" "umask 077 && cat > $DEPLOY_DIR/.env && chmod 600 $DEPLOY_DIR/.env" < "$DEPLOY_ENV_FILE"
fi
if [[ "$sync_config" == true ]]; then
  step "Sync $DEPLOY_CONFIG_FILE -> ~/$REMOTE_CONFIG_DIR/config.jsonc"
  ssh "$DEPLOY_SERVER" "umask 077 && mkdir -p $REMOTE_CONFIG_DIR && cat > $REMOTE_CONFIG_DIR/config.jsonc" < "$DEPLOY_CONFIG_FILE"
fi

step "Sync files"
rsync_flags=(-az --delete)
case "$(uname -s)" in
  MINGW* | MSYS*) rsync_flags+=(--protocol=32) ;;
esac
rsync "${rsync_flags[@]}" \
  --exclude=node_modules/ \
  --exclude=/.data/ \
  --exclude=/data/ \
  --exclude='.env*' \
  --exclude=/.deploy.env \
  --exclude=.git/ \
  --exclude=/.codenomad/ \
  --exclude=/spikes/ \
  --include=/.timber/ \
  --include='/.timber/dist/***' \
  --exclude='/.timber/*' \
  ./ "$DEPLOY_SERVER:$DEPLOY_DIR/"

step "Install production dependencies"
remote "bun install --frozen-lockfile --production"

step "Back up the database"
remote "bun scripts/backup.ts --if-exists --tag pre-deploy-$short_sha"

step "Restart worker (runs migrations)"
remote "pm2 startOrRestart ecosystem.config.cjs --only forgesight-worker"
remote "bun scripts/deploy-check.ts wait-app forgesight-worker"

step "Restart web"
remote "pm2 startOrRestart ecosystem.config.cjs --only forgesight-web"
remote "bun scripts/deploy-check.ts health $sha"

remote "pm2 save"
step "Deployed $sha"
