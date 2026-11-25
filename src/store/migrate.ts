import type { Database } from "bun:sqlite";
import initialSql from "./migrations/001-initial.sql" with { type: "text" };
import outboxSql from "./migrations/002-outbox.sql" with { type: "text" };
import workstreamsSql from "./migrations/003-workstreams.sql" with { type: "text" };
import llmSql from "./migrations/004-llm.sql" with { type: "text" };
import { userVersion } from "./schema-version.ts";

export type Migration = { version: number; name: string; sql: string };

export const migrations: Migration[] = [
  { version: 1, name: "initial", sql: initialSql },
  { version: 2, name: "outbox", sql: outboxSql },
  { version: 3, name: "workstreams", sql: workstreamsSql },
  { version: 4, name: "llm", sql: llmSql },
];

export function latest(list: Migration[]): number {
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
