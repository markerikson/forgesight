import type { Database } from "bun:sqlite";

export function getMeta(db: Database, key: string): string | undefined {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(key);
  return row?.value;
}

export function setMeta(db: Database, key: string, value: string, now: string): void {
  db.query(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

export function deleteMeta(db: Database, key: string): void {
  db.query("DELETE FROM meta WHERE key = ?").run(key);
}
