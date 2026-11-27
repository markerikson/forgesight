import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface BackupFile {
  name: string;
  mtimeMs: number;
}

export interface Retention {
  dated: number;
  preDeploy: number;
}

export const DEFAULT_RETENTION: Retention = { dated: 14, preDeploy: 5 };

const DATED = /^inbox-\d{4}-\d{2}-\d{2}\.db$/;
const PRE_DEPLOY = /^inbox-pre-deploy-[A-Za-z0-9._-]+\.db$/;
const TAG = /^[A-Za-z0-9._-]+$/;

export function isValidTag(tag: string): boolean {
  return TAG.test(tag);
}

export function backupFileName(tag: string): string {
  if (!isValidTag(tag)) throw new Error(`Invalid backup tag: ${tag}`);
  return `inbox-${tag}.db`;
}

/** The default tag: the UTC date, `YYYY-MM-DD`. */
export function dateTag(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Backups to delete: all but the newest `dated` date-tagged files (by date in the name) and
 * the newest `preDeploy` pre-deploy files (by mtime, since their names hold a sha).
 * Files with any other tag are never deleted.
 */
export function backupsToDelete(files: readonly BackupFile[], keep: Retention = DEFAULT_RETENTION): string[] {
  const dated = files.filter((f) => DATED.test(f.name)).toSorted((a, b) => b.name.localeCompare(a.name));
  const preDeploy = files
    .filter((f) => PRE_DEPLOY.test(f.name))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return [...dated.slice(keep.dated), ...preDeploy.slice(keep.preDeploy)].map((f) => f.name);
}

export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".db"))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
}

/**
 * Copies `dbPath` to `outPath` with `VACUUM INTO`, which is safe while another process writes
 * (WAL). Writes to a temporary file first, so an existing backup with the same name is only
 * replaced by a copy that passed `PRAGMA integrity_check`.
 */
export function backupDb(dbPath: string, outPath: string): void {
  const tmp = `${outPath}.tmp`;
  rmSync(tmp, { force: true });
  const src = new Database(dbPath, { readwrite: true, create: false });
  try {
    src.run("PRAGMA busy_timeout=5000");
    src.prepare("VACUUM INTO ?").run(tmp);
  } finally {
    src.close();
  }
  const copy = new Database(tmp, { readonly: true });
  let result: string;
  try {
    const rows = copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    result = rows.map((r) => r.integrity_check).join("; ");
  } finally {
    copy.close();
  }
  if (result !== "ok") {
    rmSync(tmp, { force: true });
    throw new Error(`Integrity check failed for ${outPath}: ${result}`);
  }
  renameSync(tmp, outPath);
}
