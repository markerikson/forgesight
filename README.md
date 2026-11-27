# Forgesight

A personal GitHub notifications inbox. A Bun worker polls GitHub into a SQLite file, and a Bun web app serves the inbox from it.

## Local development

```sh
bun install
cp .env.example .env          # sets FORGESIGHT_DATA_DIR=./.data
bun run db:migrate
bun run worker                # flags: --once, --no-github
bun run fixture:record replayio/backend#14148 [--name case-name]
bun run dev                   # web UI on http://127.0.0.1:<server.port> (default 4630)

bun run build                 # production web build into .timber/dist
bun run start                 # serve the production build on the same address

bun test src
bun run typecheck
bun run lint
```

The GitHub token comes from `GITHUB_TOKEN`, or `gh auth token` when that is unset.

The web app reads the same database read-only and answers 503 until `db:migrate` (or the worker) has brought the schema up to date. It only accepts requests whose `Host` is loopback or listed in `server.allowedHosts`.

## Config and data

- Config: `$FORGESIGHT_CONFIG`, else `$XDG_CONFIG_HOME/forgesight/config.jsonc` (`~/.config/...` by default). The file is optional; missing fields use the defaults in `src/config/defaults.ts`.
- Data (`inbox.db`, `backups/`): `$FORGESIGHT_DATA_DIR`, else `$XDG_DATA_HOME/forgesight` (`~/.local/share/forgesight` by default).

## Self-hosting

`scripts/deploy.ts` builds on your machine and deploys over ssh to a Linux server, where pm2 runs two apps from `ecosystem.config.cjs`: `forgesight-worker` and `forgesight-web`. The server needs Bun 1.4 or newer (older versions can't read `bun.lock`), pm2 (with Node), and rsync. The web app has no login and listens on 127.0.0.1 only, so how you reach it (ssh tunnel, private network, reverse proxy with auth) is up to you. Add any hostname you use to `server.allowedHosts`.

On the server, code lives in `DEPLOY_DIR` (default `/opt/forgesight`), secrets in `$DEPLOY_DIR/.env` (Bun loads it from the working directory), and config in `~/.config/forgesight/config.jsonc` for the ssh user. Set `FORGESIGHT_DATA_DIR` in `.env`, for example to `$DEPLOY_DIR/data`. pm2 logs go to `$DEPLOY_DIR/data/logs/`.

Deploying needs `ssh` and `rsync` on your machine too. Deploy settings come from a gitignored `.deploy.env` in the repo root (plain `KEY=value` lines; a leading `~/` is expanded) or from environment variables, which take precedence:

```sh
DEPLOY_SERVER=user@your-server       # ssh destination or Host alias (required)
DEPLOY_DIR=/opt/forgesight           # optional; absolute path on the server
DEPLOY_ENV_FILE=.env.production      # optional; uploaded as $DEPLOY_DIR/.env by --sync-env
DEPLOY_CONFIG_FILE=~/forgesight-server.jsonc   # uploaded as the server config by --sync-config
```

```sh
bun run deploy          # checks, build, rsync, restart worker then web, verify
bun run deploy:full     # also uploads the env file and config
bun scripts/deploy.ts --skip-checks --allow-dirty
```

`deploy.ts` refuses a dirty tree unless `--allow-dirty`, runs typecheck, lint and tests unless `--skip-checks`, writes `build-info.json`, builds, rsyncs the repo (with `.timber/dist`, without `node_modules`, `data`, `.env*`, `.git`), runs `bun install --production` on the server, backs up the database as `inbox-pre-deploy-<sha>-<UTC time>.db`, restarts the worker (which migrates), waits for it to stay online, restarts the web, and waits until `/api/health` reports the new sha. It then prints `worker.alive` and `outbox.dryRun` from `/api/status`, and runs `pm2 save`. Run `pm2 startup` once on the server so pm2 restores the apps after a reboot.

### First deploy

1. `cp .env.production.example .env.production` and fill in `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`.
2. Write the server config and point `DEPLOY_CONFIG_FILE` at it. Keeping `"outbox": { "dryRun": true }` at first is a safe way to watch the worker before it changes anything on GitHub. Actions you take while in dry run are recorded locally and are not sent to GitHub when you turn it off.
3. Stop any other worker polling the same GitHub account.
4. `bun run deploy:full`. The worker creates the database on its first poll, and the web answers 503 until then. To keep existing history, copy a backup to `$FORGESIGHT_DATA_DIR/inbox.db` on the server before this step.
5. Schedule a nightly backup on the server, for example in crontab:
   `30 3 * * * cd /opt/forgesight && ~/.bun/bin/bun scripts/backup.ts >> data/logs/backup.log 2>&1`

The worker reads config only at startup. After changing only the config, restart it with `pm2 restart forgesight-worker`.

### Operations

- `pm2 ls`, `pm2 logs forgesight-worker`: status and logs on the server.
- `pm2 stop forgesight-worker`: stops all GitHub reads and writes. The web keeps serving the last data.
- `bun scripts/backup.ts [--tag <tag>]` writes `$FORGESIGHT_DATA_DIR/backups/inbox-<tag>.db` with `VACUUM INTO` and checks it with `PRAGMA integrity_check`. The tag defaults to the UTC date. It keeps the 14 newest dated backups and the 5 newest pre-deploy backups.
- `bun run rederive` (on the server, from the deploy directory) re-derives every subject view from the stored data, without GitHub calls. Run it after a deploy that changes what the views show but does not bump `PIPELINE_VERSION`. It is safe to run while the worker runs: it works in short batches, and the open browser tabs pick up the changes.
- If GitHub rejects the token, the worker keeps running with GitHub calls stopped, and the status bar shows "GitHub auth failed". Upload a new `GITHUB_TOKEN` with `bun run deploy:full` or edit `.env` on the server; the worker notices the changed `.env` within a tick, and otherwise retries every 5 minutes.
- `bun run backup:pull [dest]` asks the server for its backup directory and copies the backups to `~/forgesight-backups/` (or `dest`).

### Rollback

- No migration since the good commit: `git checkout <good-sha>` and `bun scripts/deploy.ts --skip-checks`.
- A migration ran: the old code cannot open the newer schema. On the server:
  ```sh
  pm2 stop forgesight-worker forgesight-web
  cd "$FORGESIGHT_DATA_DIR"
  mv inbox.db inbox.db.bad && rm -f inbox.db-wal inbox.db-shm
  cp backups/inbox-pre-deploy-<bad-short-sha>-<time>.db inbox.db
  ```
  Then deploy the good sha as above. The pre-deploy backup is named after the sha being deployed and the UTC time, and holds the schema from before it.


## Layout

- `src/core` — pure pipeline logic. No package imports, no Bun/Node/DOM APIs, no clock or env reads. Lint and a separate `src/core/tsconfig.json` enforce this.
- `src/config` — config schema, defaults, loading, and paths.
- `src/store`, `src/github`, `src/worker` — SQLite store, GitHub client, and worker process.
- `app/` — Timber routes. Thin adapters that call into `src/server`.
- `src/server` — web request context, guards, and route handlers (`(req, ctx) => Response`).
- `src/web` — client UI and the RTK Query store.
- `scripts/` — developer scripts.
