import type { Database } from "bun:sqlite";

/** Version of the newest migration in `migrate.ts`. Bump it with every new migration. */
export const SCHEMA_VERSION = 3;

export function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/**
 * For the web process, which never migrates: throws unless the database matches the code.
 * Kept apart from `migrate.ts` so the web never loads the migration SQL.
 */
export function assertCurrent(db: Database, expected: number = SCHEMA_VERSION): void {
  const current = userVersion(db);
  if (current < expected) {
    throw new Error(`Database is at version ${current}, code expects ${expected}. Run the worker or \`bun run db:migrate\`.`);
  }
  if (current > expected) {
    throw new Error(`Database is at version ${current}, newer than this code (${expected}). Deploy the current code.`);
  }
}
