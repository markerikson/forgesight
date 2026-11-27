// Builds locally, syncs to the server over ssh/rsync, and restarts the pm2 apps.
// Usage: bun scripts/deploy.ts [--sync-env] [--sync-config] [--skip-checks] [--allow-dirty]
// Settings come from .deploy.env or the environment: see the Self-hosting section of the README.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { writeBuildInfo } from "../src/deploy/build-info.ts";
import {
  loadSettings,
  REMOTE_CONFIG_DIR,
  remoteCommand,
  RSYNC_FILTERS,
  rsyncPlatformFlags,
  shellQuote,
} from "../src/deploy/settings.ts";

const root = join(import.meta.dir, "..");
$.cwd(root);

const { values: flags } = parseArgs({
  options: {
    "sync-env": { type: "boolean" },
    "sync-config": { type: "boolean" },
    "skip-checks": { type: "boolean" },
    "allow-dirty": { type: "boolean" },
  },
});

function step(message: string): void {
  console.log(`\n==> ${message}`);
}

function fail(message: string): never {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

const settings = await loadSettings(root).catch((err: unknown) =>
  fail(err instanceof Error ? err.message : String(err)),
);
const { server, dir } = settings;
const envFile = resolve(root, settings.envFile);
const configFile = settings.configFile ? resolve(root, settings.configFile) : null;

if (flags["sync-env"] && !existsSync(envFile)) fail(`env file not found: ${envFile}`);
if (flags["sync-config"]) {
  if (!configFile) fail("--sync-config needs DEPLOY_CONFIG_FILE");
  if (!existsSync(configFile)) fail(`config file not found: ${configFile}`);
}

function remote(command: string) {
  return $`ssh ${server} ${remoteCommand(dir, command)}`;
}

async function deploy(): Promise<void> {
  let sha = (await $`git rev-parse HEAD`.text()).trim();
  let shortSha = (await $`git rev-parse --short HEAD`.text()).trim();
  if ((await $`git status --porcelain`.text()).trim()) {
    if (!flags["allow-dirty"]) fail("working tree has uncommitted changes (use --allow-dirty to deploy anyway)");
    sha += "-dirty";
    shortSha += "-dirty";
  }
  console.log(`Deploying ${sha} to ${server}:${dir}`);

  if (!flags["skip-checks"]) {
    step("Checks");
    await $`bun run typecheck`;
    await $`bun run lint`;
    await $`bun run test`;
  }

  step("Build");
  const info = await writeBuildInfo(root, sha, new Date());
  console.log(`build-info.json: ${info.sha} ${info.time}`);
  await $`bun run build`;

  step("Prepare server");
  await $`ssh ${server} ${`mkdir -p ${shellQuote(`${dir}/data/backups`)} ${shellQuote(`${dir}/data/logs`)}`}`;

  if (flags["sync-env"]) {
    step("Sync .env");
    const target = shellQuote(`${dir}/.env`);
    await $`ssh ${server} ${`umask 077 && cat > ${target} && chmod 600 ${target}`} < ${Bun.file(envFile)}`;
  }
  if (configFile && flags["sync-config"]) {
    step("Sync config");
    const target = `${REMOTE_CONFIG_DIR}/config.jsonc`;
    await $`ssh ${server} ${`umask 077 && mkdir -p ${REMOTE_CONFIG_DIR} && cat > ${target}`} < ${Bun.file(configFile)}`;
  }

  step("Sync files");
  await $`rsync -az --delete ${rsyncPlatformFlags(process.platform)} ${RSYNC_FILTERS} ./ ${`${server}:${dir}/`}`;

  step("Install dependencies");
  await remote("bun install --frozen-lockfile --production");

  step("Back up database");
  await remote(`bun scripts/backup.ts --if-exists --tag pre-deploy-${shortSha}`);

  for (const app of ["forgesight-worker", "forgesight-web"]) {
    step(`Restart ${app}`);
    // oxlint-disable-next-line no-await-in-loop -- the worker must be up before the web app restarts
    await remote(`pm2 startOrRestart ecosystem.config.cjs --only ${app}`);
    // oxlint-disable-next-line no-await-in-loop -- same
    await remote(`bun scripts/deploy-check.ts wait-app ${app}`);
  }

  step("Health check");
  await remote(`bun scripts/deploy-check.ts health ${sha}`);
  await remote("pm2 save");

  step(`Deployed ${sha}`);
}

try {
  await deploy();
} catch (err) {
  if (err instanceof $.ShellError) fail(`command failed with exit code ${err.exitCode}`);
  throw err;
}
