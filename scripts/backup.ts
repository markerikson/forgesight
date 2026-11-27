// Snapshots inbox.db into <data dir>/backups/inbox-<tag>.db and prunes old backups.
// Usage: bun scripts/backup.ts [--tag <tag>] [--if-exists]
//   --tag        defaults to the UTC date
//   --if-exists  exit 0 without a backup when there is no database yet
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir } from "../src/config/paths.ts";
import { backupDb, backupFileName, backupsToDelete, dateTag, listBackups } from "../src/store/backups.ts";

const { values } = parseArgs({
  options: { tag: { type: "string" }, "if-exists": { type: "boolean" } },
});
const tag = values.tag ?? dateTag(new Date());

const data = dataDir();
const dbPath = join(data, "inbox.db");
if (values["if-exists"] && !existsSync(dbPath)) {
  console.log(`${new Date().toISOString()} no database at ${dbPath}, skipping backup`);
  process.exit(0);
}
const dir = join(data, "backups");
mkdirSync(dir, { recursive: true });

const out = join(dir, backupFileName(tag));
try {
  backupDb(dbPath, out);
} catch (err) {
  console.error(`${new Date().toISOString()} backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
console.log(`${new Date().toISOString()} wrote ${out}`);

for (const name of backupsToDelete(listBackups(dir))) {
  rmSync(join(dir, name), { force: true });
  console.log(`${new Date().toISOString()} deleted ${name}`);
}
