# Forgesight

A personal GitHub notifications inbox. A Bun worker polls GitHub into a SQLite file, and a Bun web app serves the inbox from it.

## Local development

```sh
bun install
cp .env.example .env          # sets FORGESIGHT_DATA_DIR=./.data
bun run db:migrate
bun run worker                # flags: --once, --no-github
bun run fixture:record replayio/backend#14148 [--name case-name]
bun run dev                   # web UI on http://127.0.0.1:4630

bun run build                 # production web build into .timber/dist
bun run start                 # serve the production build on 127.0.0.1:4630

bun test src
bun run typecheck
bun run lint
```

The GitHub token comes from `GITHUB_TOKEN`, or `gh auth token` when that is unset.

The web app reads the same database read-only and answers 503 until `db:migrate` (or the worker) has brought the schema up to date. It only accepts requests whose `Host` is loopback or listed in `server.allowedHosts`.

## Config and data

- Config: `$FORGESIGHT_CONFIG`, else `$XDG_CONFIG_HOME/forgesight/config.jsonc` (`~/.config/...` by default). The file is optional; missing fields use the defaults in `src/config/defaults.ts`.
- Data (`inbox.db`, `backups/`): `$FORGESIGHT_DATA_DIR`, else `$XDG_DATA_HOME/forgesight` (`~/.local/share/forgesight` by default).

## Layout

- `src/core` — pure pipeline logic. No package imports, no Bun/Node/DOM APIs, no clock or env reads. Lint and a separate `src/core/tsconfig.json` enforce this.
- `src/config` — config schema, defaults, loading, and paths.
- `src/store`, `src/github`, `src/worker` — SQLite store, GitHub client, and worker process.
- `app/` — Timber routes. Thin adapters that call into `src/server`.
- `src/server` — web request context, guards, and route handlers (`(req, ctx) => Response`).
- `src/web` — client UI and the RTK Query store.
- `scripts/` — developer scripts.
