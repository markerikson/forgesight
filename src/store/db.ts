import { Database } from "bun:sqlite";
import { join } from "node:path";
import { dataDir } from "../config/paths.ts";

export function defaultDbPath(): string {
  return join(dataDir(), "inbox.db");
}

/** Opens the SQLite file with WAL and the shared PRAGMAs. Pass `":memory:"` in tests. */
export function openDb(path: string, opts?: { readonly?: boolean }): Database {
  const readonly = opts?.readonly ?? false;
  const db = readonly
    ? new Database(path, { readonly: true, strict: true })
    : new Database(path, { create: true, readwrite: true, strict: true });
  if (!readonly) {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=NORMAL");
  }
  db.run("PRAGMA foreign_keys=ON");
  db.run("PRAGMA busy_timeout=5000");
  return db;
}
