// Helper steps for scripts/deploy.sh.
//   bun scripts/deploy-check.ts build-info <sha>    write build-info.json (local, before the build)
//   bun scripts/deploy-check.ts wait-app <name>     wait until a pm2 app stays online (on the server)
//   bun scripts/deploy-check.ts health <sha>        wait for /api/health to report <sha>, then print status (on the server)
import { loadConfig } from "../src/config/load.ts";
import { configPath } from "../src/config/paths.ts";
import { writeBuildInfo } from "../src/deploy/build-info.ts";
import { pm2AppState, readiness } from "../src/deploy/pm2.ts";

const MIN_UPTIME_MS = 10_000;
const WAIT_APP_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 30_000;

const [command, arg] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function pm2Jlist(): Promise<string> {
  const proc = Bun.spawn(["pm2", "jlist"], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) fail("pm2 jlist failed");
  return out;
}

async function waitApp(name: string): Promise<void> {
  const deadline = Date.now() + WAIT_APP_TIMEOUT_MS;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling pm2 until the app settles
    const state = pm2AppState(await pm2Jlist(), name, Date.now());
    const result = readiness(state, MIN_UPTIME_MS);
    if (result === "ready") {
      console.log(`${name} online (restarts: ${state?.restarts ?? 0})`);
      return;
    }
    if (result === "failed" || Date.now() > deadline) {
      fail(`${name} did not stay online: ${state ? `${state.status}, restarts ${state.restarts}` : "not in pm2"}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- polling interval
    await Bun.sleep(1000);
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function health(sha: string): Promise<void> {
  const { config } = await loadConfig(configPath());
  const base = `http://127.0.0.1:${config.server.port}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "no response";
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- polling until the new build answers
      const body = (await getJson(`${base}/api/health`)) as { version?: unknown };
      if (body.version === sha) break;
      last = `version ${String(body.version)}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() > deadline) fail(`/api/health never reported ${sha} (last: ${last})`);
    // oxlint-disable-next-line no-await-in-loop -- polling interval
    await Bun.sleep(1000);
  }
  console.log(`/api/health reports ${sha}`);

  const status = (await getJson(`${base}/api/status`)) as {
    worker?: { alive?: unknown; status?: unknown };
    outbox?: { dryRun?: unknown };
    configError?: unknown;
  };
  console.log(`worker.alive: ${String(status.worker?.alive)} (${String(status.worker?.status)})`);
  console.log(`outbox.dryRun: ${String(status.outbox?.dryRun)}`);
  if (status.configError) console.log(`configError: ${String(status.configError)}`);
}

switch (command) {
  case "build-info": {
    if (!arg) fail("usage: deploy-check.ts build-info <sha>");
    const info = await writeBuildInfo(process.cwd(), arg, new Date());
    console.log(`build-info.json: ${info.sha} ${info.time}`);
    break;
  }
  case "wait-app":
    if (!arg) fail("usage: deploy-check.ts wait-app <name>");
    await waitApp(arg);
    break;
  case "health":
    if (!arg) fail("usage: deploy-check.ts health <sha>");
    await health(arg);
    break;
  default:
    fail("usage: deploy-check.ts build-info|wait-app|health <arg>");
}
