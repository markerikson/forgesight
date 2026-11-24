import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.ts";
import { META } from "../core/meta-keys.ts";
import { configPath } from "../config/paths.ts";
import { Governor } from "../github/budget.ts";
import { createGitHubClient } from "../github/client.ts";
import { TokenError } from "../github/errors.ts";
import { resolveToken } from "../github/token.ts";
import type { GitHubClient } from "../github/types.ts";
import { defaultDbPath, openDb } from "../store/db.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { runMigrations } from "../store/migrate.ts";
import { SqliteApiCallLog } from "./api-call-log.ts";
import { deriveJob, deriveViews } from "./derive.ts";
import { enrichJob } from "./enrich.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { openPullsJob } from "./open-pulls.ts";
import { createPoller } from "./poller.ts";
import { consoleLogger, Scheduler, WORKER_STATUS_KEY } from "./scheduler.ts";

const { values: args } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    "no-github": { type: "boolean", default: false },
  },
});

const log = consoleLogger;
const clock = () => new Date();
const path = configPath();
const { config, hash, error } = await loadConfig(path);
if (error) log.warn(`Config error, using defaults: ${error}`);
const dbPath = defaultDbPath();
log.info(`Config ${path} (hash ${hash.slice(0, 12)}), database ${dbPath}`);

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
runMigrations(db);

if (args["no-github"]) {
  const me = config.me ?? getMeta(db, META.viewerLogin) ?? null;
  if (!me) log.warn("--no-github: no `me` in config and no stored viewer login");
  const summary = deriveViews(db, { ...config, me }, clock(), log);
  log.info(`--no-github finished: ${summary.derived} views derived in ${summary.ms}ms`);
  db.close();
  process.exit(summary.failed > 0 ? 1 : 0);
}

const governor = new Governor(new SqliteApiCallLog(db), config.budget, clock);
let gh: GitHubClient;
let viewer: string;
try {
  gh = createGitHubClient(config, resolveToken(), { governor, clock });
  viewer = await gh.viewerLogin();
} catch (e) {
  if (!(e instanceof TokenError)) throw e;
  log.error(`GitHub token problem: ${e.message}`);
  setMeta(db, WORKER_STATUS_KEY, "auth_failed", clock().toISOString());
  db.close();
  process.exit(1);
}
setMeta(db, META.viewerLogin, viewer, clock().toISOString());
if (config.me && config.me !== viewer) {
  log.warn(`Config "me" is ${config.me} but the token belongs to ${viewer}; using ${config.me}.`);
}
const effectiveConfig = config.me ? config : { ...config, me: viewer };
log.info(`Signed in as ${viewer}`);

const stopHeartbeat = startHeartbeat(db, clock);
const poller = createPoller();
// A tick runs jobs in this order until one does work, so enrichment waits for poll and
// backfill, and derive runs once fetching is idle.
const scheduler = new Scheduler(
  { db, gh, governor, config: effectiveConfig, clock, log },
  [poller.pollJob, poller.backfillJob, openPullsJob, enrichJob, deriveJob],
);

if (args.once) {
  poller.request();
  const result = await scheduler.drain();
  stopHeartbeat();
  const failing = scheduler.failingJobs();
  for (const [name, count] of failing) log.error(`${name} still failing after ${count} attempts`);
  log.info(`--once finished: ${result}`);
  db.close();
  process.exit(result === "stopped" || failing.size > 0 ? 1 : 0);
}

let interrupted = false;
const shutdown = () => {
  log.info("Stopping after the current job");
  interrupted = true;
  scheduler.stop();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await scheduler.run();
stopHeartbeat();
// An auth failure already wrote its own status.
if (interrupted) setMeta(db, WORKER_STATUS_KEY, "stopped", clock().toISOString());
db.close();
process.exit(interrupted ? 0 : 1);
