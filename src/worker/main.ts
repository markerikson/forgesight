import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.ts";
import { META } from "../core/meta-keys.ts";
import { configPath } from "../config/paths.ts";
import { Governor } from "../github/budget.ts";
import { createGitHubClient } from "../github/client.ts";
import { TokenError } from "../github/errors.ts";
import { ANTHROPIC_API_KEY_ENV, llmClientFor } from "../llm/client.ts";
import type { LlmClient } from "../llm/types.ts";
import { resolveToken } from "../github/token.ts";
import type { GitHubClient } from "../github/types.ts";
import { defaultDbPath, openDb } from "../store/db.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { runMigrations } from "../store/migrate.ts";
import { SqliteApiCallLog } from "./api-call-log.ts";
import { deriveJob, deriveViews } from "./derive.ts";
import { doneSyncJob } from "./done-sync.ts";
import { enrichJob, urgentEnrichJob } from "./enrich.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { maintenanceJob } from "./maintenance.ts";
import { openPullsJob } from "./open-pulls.ts";
import { outboxJob } from "./outbox.ts";
import { createPoller } from "./poller.ts";
import { rebaseDetectorJob } from "./rebase-detector.ts";
import { consoleLogger, Scheduler, WORKER_STATUS_KEY } from "./scheduler.ts";
import { currentEnv, ENV_PATH, fileChangeWatcher, rejectingGitHubClient } from "./credentials.ts";
import type { Config } from "../core/config.ts";
import { createWorkstreamSummaryJobs } from "./workstream-summaries.ts";

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

// Startup signs in with the environment the worker started with. A retry after a rejected
// token reads `.env` as it is on disk now, so a rotated token is picked up without a restart.
async function connect(env: Record<string, string | undefined>): Promise<{ gh: GitHubClient; config: Config }> {
  const client = createGitHubClient(config, resolveToken({ env }), { governor, clock });
  const viewer = await client.viewerLogin();
  setMeta(db, META.viewerLogin, viewer, clock().toISOString());
  if (config.me && config.me !== viewer) {
    log.warn(`Config "me" is ${config.me} but the token belongs to ${viewer}; using ${config.me}.`);
  }
  log.info(`Signed in as ${viewer}`);
  return { gh: client, config: config.me ? config : { ...config, me: viewer } };
}

let connection: { gh: GitHubClient; config: Config };
let authError: TokenError | null = null;
try {
  connection = await connect(process.env);
} catch (e) {
  if (!(e instanceof TokenError)) throw e;
  authError = e;
  // Keep running local jobs with the last known viewer until the token works again.
  const me = config.me ?? getMeta(db, META.viewerLogin) ?? null;
  connection = { gh: rejectingGitHubClient(e), config: { ...config, me } };
}
const credentialsChanged = fileChangeWatcher(ENV_PATH);
setMeta(db, META.outboxDryRun, config.outbox.dryRun ? "1" : "0", clock().toISOString());
if (config.outbox.dryRun) log.warn("Outbox dry run: GitHub writes are completed locally and not sent.");
// A broken config falls back to defaults, which would turn a configured dry run into live
// writes. Hold queued writes until the config loads.
if (error) log.warn("Outbox paused until the config error is fixed; queued GitHub writes are held.");

const stopHeartbeat = startHeartbeat(db, clock);
const poller = createPoller();
let llm: LlmClient | null = null;
try {
  llm = llmClientFor(config.llm.tasks.workstreamSummary);
  if (!llm) log.warn(`${ANTHROPIC_API_KEY_ENV} is not set; workstream summaries are off`);
} catch (err) {
  log.error(`${err instanceof Error ? err.message : String(err)}; workstream summaries are off`);
}
const summaryJobs = createWorkstreamSummaryJobs({ llm });
// A tick runs the GitHub jobs in this order until one does work. Subjects opened in the web
// app go first, then the poll; the outbox sends queued user writes right after it. PR texts
// for summaries and push rebase checks come before the enrich queue so a long backlog does not hold them back.
// Summaries call Anthropic, not GitHub, so they get their own turn every tick, followed by
// the local derive and maintenance jobs. The API key is read once at startup, so setting it
// needs a worker restart.
const jobContext = { db, gh: connection.gh, governor, config: connection.config, clock, log };
const scheduler = new Scheduler(jobContext, [
  urgentEnrichJob,
  poller.pollJob,
  ...(error ? [] : [outboxJob]),
  poller.backfillJob,
  openPullsJob,
  rebaseDetectorJob,
  summaryJobs.texts,
  enrichJob,
  doneSyncJob,
  ...(summaryJobs.summaries ? [summaryJobs.summaries] : []),
  deriveJob,
  maintenanceJob,
], { reconnect: async () => connect(await currentEnv(ENV_PATH)), credentialsChanged });
if (authError) scheduler.markAuthFailed(authError.message);

if (args.once) {
  poller.request();
  const result = await scheduler.drain();
  stopHeartbeat();
  const failing = scheduler.failingJobs();
  for (const [name, count] of failing) log.error(`${name} still failing after ${count} attempts`);
  log.info(`--once finished: ${result}`);
  db.close();
  process.exit(result === "stopped" || result === "auth_failed" || failing.size > 0 ? 1 : 0);
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
if (interrupted) setMeta(db, WORKER_STATUS_KEY, "stopped", clock().toISOString());
db.close();
process.exit(interrupted ? 0 : 1);
