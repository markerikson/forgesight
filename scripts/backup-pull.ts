// Copies the server's database backups to this machine.
// Usage: bun scripts/backup-pull.ts [dest]   (dest defaults to ~/forgesight-backups/)
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { loadSettings, remoteCommand, rsyncPlatformFlags } from "../src/deploy/settings.ts";

const root = join(import.meta.dir, "..");
const { server, dir } = await loadSettings(root).catch((err: unknown) => {
  console.error(`backup-pull: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

const dest = resolve(process.argv[2] ?? join(homedir(), "forgesight-backups"));
mkdirSync(dest, { recursive: true });

// Ask the server, since FORGESIGHT_DATA_DIR in its .env decides where backups go.
const output = await $`ssh ${server} ${remoteCommand(dir, "bun scripts/deploy-check.ts backup-dir")}`.text();
const backupDir = output.trim().split("\n").at(-1)?.trim();
if (!backupDir?.startsWith("/")) {
  console.error(`backup-pull: unexpected backup directory from the server: ${output.trim()}`);
  process.exit(1);
}

await $`rsync -az ${rsyncPlatformFlags(process.platform)} ${`${server}:${backupDir}/`} ${`${dest}/`}`;

const newest = readdirSync(dest)
  .map((name) => ({ name, mtimeMs: statSync(join(dest, name)).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs)
  .slice(0, 5);
console.log(`Backups in ${dest} (newest first):`);
for (const { name, mtimeMs } of newest) console.log(`  ${new Date(mtimeMs).toISOString()}  ${name}`);
