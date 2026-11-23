import type { Database } from "bun:sqlite";
import type { ThreadRecord, ThreadUpsert } from "../core/types.ts";
import { bool, threadFromRow, type ThreadRow, toJson } from "./rows.ts";

/**
 * Inserts or updates threads. `firstSeenAt` is set to `now` on insert and kept after;
 * `ghDoneAt` is never touched here. Returns the subjects with a new thread or a thread
 * whose `updated_at` moved, in first-seen order.
 */
export function upsertThreads(
  db: Database,
  threads: ThreadUpsert[],
  now: string,
): { changedSubjectKeys: string[] } {
  const existing = db.query<{ updated_at: string }, [string]>(
    "SELECT updated_at FROM threads WHERE thread_id = ?",
  );
  const upsert = db.query(
    `INSERT INTO threads (thread_id, subject_key, repo, subject_type, reason, unread,
       updated_at, last_read_at, first_seen_at, subject_url, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET
       subject_key = excluded.subject_key, repo = excluded.repo,
       subject_type = excluded.subject_type, reason = excluded.reason, unread = excluded.unread,
       updated_at = excluded.updated_at, last_read_at = excluded.last_read_at,
       subject_url = excluded.subject_url, raw_json = excluded.raw_json`,
  );
  const changed = new Set<string>();
  db.transaction(() => {
    for (const t of threads) {
      const prev = existing.get(t.threadId);
      if (!prev || prev.updated_at !== t.updatedAt) changed.add(t.subjectKey);
      upsert.run(
        t.threadId,
        t.subjectKey,
        t.repo,
        t.subjectType,
        t.reason,
        bool(t.unread),
        t.updatedAt,
        t.lastReadAt,
        now,
        t.subjectUrl,
        toJson(t.raw),
      );
    }
  })();
  return { changedSubjectKeys: [...changed] };
}

export function threadsForSubject(db: Database, subjectKey: string): ThreadRecord[] {
  return db
    .query<ThreadRow, [string]>(
      "SELECT * FROM threads WHERE subject_key = ? ORDER BY updated_at DESC, thread_id",
    )
    .all(subjectKey)
    .map(threadFromRow);
}

/** Newest first. `since` keeps threads with `updated_at >= since`. */
export function listThreads(
  db: Database,
  opts: { since?: string; limit?: number } = {},
): ThreadRecord[] {
  return db
    .query<ThreadRow, [string | null, string | null, number]>(
      `SELECT * FROM threads WHERE (? IS NULL OR updated_at >= ?)
       ORDER BY updated_at DESC, thread_id LIMIT ?`,
    )
    .all(opts.since ?? null, opts.since ?? null, opts.limit ?? -1)
    .map(threadFromRow);
}
