import type { Database } from "bun:sqlite";
import { configPath } from "../config/paths.ts";
import { type LoadedConfig, loadConfig } from "../config/load.ts";
import type { Config } from "../core/config.ts";
import { defaultDbPath, openDb } from "../store/db.ts";
import { assertCurrent } from "../store/schema-version.ts";

export interface ServerCtx {
  db: Database;
  config: Config;
  configError: string | null;
  now: () => Date;
  /** The read-write connection, opened on first use. Only POST handlers call it. */
  writeDb: () => Database;
}

/** The database is missing or its schema does not match this build; the worker or `db:migrate` fixes it. */
export class NotReadyError extends Error {
  override name = "NotReadyError";
}

let configPromise: Promise<LoadedConfig> | undefined;
let ctxPromise: Promise<ServerCtx> | undefined;

/** The user config, loaded once per process. Guards need it before the database is open. */
export function getConfig(): Promise<LoadedConfig> {
  configPromise ??= loadConfig(configPath());
  return configPromise;
}

export function openServerDb(path: string, opts: { readonly: boolean } = { readonly: true }): Database {
  let db: Database;
  try {
    db = openDb(path, opts);
  } catch (err) {
    throw new NotReadyError(
      `Cannot open ${path}: ${(err as Error).message}. Run \`bun run db:migrate\` or start the worker.`,
    );
  }
  try {
    assertCurrent(db);
  } catch (err) {
    db.close();
    throw new NotReadyError((err as Error).message);
  }
  return db;
}

let writeDb: Database | undefined;

/**
 * The per-process read-write connection, opened on first use. WAL mode and the busy timeout
 * let it write while the worker does; every web write is one short transaction.
 */
export function getWriteDb(): Database {
  writeDb ??= openServerDb(defaultDbPath(), { readonly: false });
  try {
    assertCurrent(writeDb);
  } catch (err) {
    writeDb.close();
    writeDb = undefined;
    throw new NotReadyError((err as Error).message);
  }
  return writeDb;
}

async function createCtx(): Promise<ServerCtx> {
  const loaded = await getConfig();
  return {
    db: openServerDb(defaultDbPath()),
    config: loaded.config,
    configError: loaded.error ?? null,
    now: () => new Date(),
    writeDb: getWriteDb,
  };
}

/**
 * The per-process server context. A failed open is not cached, so the next request
 * retries once migrations have run. The schema version is re-checked on every call
 * (one PRAGMA read), so a worker that migrates under a running web process drops the
 * cached connection instead of serving queries against the new schema.
 */
export async function getCtx(): Promise<ServerCtx> {
  if (!ctxPromise) {
    const pending = createCtx();
    ctxPromise = pending;
    pending.catch(() => {
      if (ctxPromise === pending) ctxPromise = undefined;
    });
  }
  const current = ctxPromise;
  const ctx = await current;
  try {
    assertCurrent(ctx.db);
  } catch (err) {
    if (ctxPromise === current) {
      ctxPromise = undefined;
      ctx.db.close();
    }
    throw new NotReadyError((err as Error).message);
  }
  return ctx;
}
