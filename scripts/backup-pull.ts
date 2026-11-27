// Copies the server's database backups to this machine.
// Usage: bun scripts/backup-pull.ts [dest]   (dest defaults to ~/forgesight-backups/)
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { loadSettings, rsyncPlatformFlags } from "../src/deploy/settings.ts";

const root = join(import.meta.dir, "..");
const { server, dir } = await loadSettings(root).catch((err: unknown) => {
  console.error(`backup-pull: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

const dest = resolve(process.argv[2] ?? join(homedir(), "forgesight-backups"));
mkdirSync(dest, { recursive: true });

await $`rsync -az ${rsyncPlatformFlags(process.platform)} ${`${server}:${dir}/data/backups/`} ${`${dest}/`}`;

const newest = readdirSync(dest)
  .map((name) => ({ name, mtimeMs: statSync(join(dest, name)).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs)
  .slice(0, 5);
console.log(`Backups in ${dest} (newest first):`);
for (const { name, mtimeMs } of newest) console.log(`  ${new Date(mtimeMs).toISOString()}  ${name}`);
