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

export function openServerDb(path: string): Database {
  let db: Database;
  try {
    db = openDb(path, { readonly: true });
  } catch (err) {
    throw new NotReadyError(
      `Cannot open ${path}: ${(err as Error).message}. Run \`bun run db:migrate\` or start the worker.`,
    );
  }
  try {
    assertCurrent(db);
  } catch (err) {
    db.close();
    throw new NotReadyError(`${(err as Error).message}. Run \`bun run db:migrate\` or restart the worker.`);
  }
  return db;
}

async function createCtx(): Promise<ServerCtx> {
  const loaded = await getConfig();
  return {
    db: openServerDb(defaultDbPath()),
    config: loaded.config,
    configError: loaded.error ?? null,
    now: () => new Date(),
  };
}

/**
 * The per-process server context. A failed open is not cached, so the next request
 * retries once migrations have run.
 */
export function getCtx(): Promise<ServerCtx> {
  if (!ctxPromise) {
    const pending = createCtx();
    ctxPromise = pending;
    pending.catch(() => {
      if (ctxPromise === pending) ctxPromise = undefined;
    });
  }
  return ctxPromise;
}
