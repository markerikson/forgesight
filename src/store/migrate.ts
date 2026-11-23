import type { Database } from "bun:sqlite";
import initialSql from "./migrations/001-initial.sql" with { type: "text" };

export type Migration = { version: number; name: string; sql: string };

export const migrations: Migration[] = [{ version: 1, name: "initial", sql: initialSql }];

function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

function latest(list: Migration[]): number {
  return list.reduce((max, m) => Math.max(max, m.version), 0);
}

/** Applies every migration newer than `PRAGMA user_version`, each in its own transaction. */
export function runMigrations(
  db: Database,
  list: Migration[] = migrations,
): { from: number; to: number } {
  const from = userVersion(db);
  const target = latest(list);
  if (from > target) {
    throw new Error(`Database is at version ${from}, newer than this code (${target}).`);
  }
  const pending = list.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.transaction(() => {
      db.run(m.sql);
      db.run(`PRAGMA user_version = ${m.version}`);
    })();
  }
  return { from, to: userVersion(db) };
}

/** For the web process, which never migrates: throws unless the database matches the code. */
export function assertCurrent(db: Database, list: Migration[] = migrations): void {
  const current = userVersion(db);
  const target = latest(list);
  if (current < target) {
    throw new Error(`Database is at version ${current}, code expects ${target}. Run the worker or \`bun run db:migrate\`.`);
  }
  if (current > target) {
    throw new Error(`Database is at version ${current}, newer than this code (${target}).`);
  }
}
