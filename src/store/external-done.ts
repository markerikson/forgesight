import type { Database } from "bun:sqlite";
import { applyStateOp } from "../core/state.ts";
import { DEFAULT_ITEM_STATE, getItemStates, putItemState } from "./item-state.ts";
import { appendChange } from "./views.ts";

export interface DoneCandidate {
  threadId: string;
  subjectKey: string;
  updatedAt: string;
}

/**
 * Threads updated since `since` that are not done here or on GitHub as far as we know: no
 * `gh_done_at`, and the subject was not marked done after the thread's latest update. Oldest first.
 */
export function doneCandidates(db: Database, since: string): DoneCandidate[] {
  return db
    .query<{ thread_id: string; subject_key: string; updated_at: string }, [string]>(
      `SELECT t.thread_id, t.subject_key, t.updated_at FROM threads t
       LEFT JOIN item_state s ON s.subject_key = t.subject_key
       WHERE t.gh_done_at IS NULL AND t.updated_at >= ?
         AND (s.done_at IS NULL OR s.done_at < t.updated_at)
       ORDER BY t.updated_at, t.thread_id`,
    )
    .all(since)
    .map((r) => ({ threadId: r.thread_id, subjectKey: r.subject_key, updatedAt: r.updated_at }));
}

/**
 * Records threads that GitHub lists as done, marked there by another client. Each thread gets
 * `gh_done_at` if its `updated_at` still matches, and a subject whose threads are now all done on
 * GitHub gets the same item state as pressing Done here, without an outbox write or an undo
 * entry. Returns the subjects marked done.
 */
export function applyExternalDone(db: Database, threads: DoneCandidate[], now: string): string[] {
  const mark = db.query(
    "UPDATE threads SET gh_done_at = ? WHERE thread_id = ? AND updated_at = ? AND gh_done_at IS NULL",
  );
  const openThreads = db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM threads WHERE subject_key = ? AND gh_done_at IS NULL",
  );
  const done: string[] = [];
  db.transaction(() => {
    const touched = new Set<string>();
    for (const t of threads) {
      if (mark.run(now, t.threadId, t.updatedAt).changes > 0) touched.add(t.subjectKey);
    }
    const keys = [...touched];
    const states = getItemStates(db, keys);
    for (const key of keys) {
      appendChange(db, "raw", key, now);
      if ((openThreads.get(key)?.n ?? 0) > 0) continue;
      putItemState(db, key, applyStateOp(states.get(key) ?? { ...DEFAULT_ITEM_STATE }, { kind: "done" }, now), now);
      done.push(key);
    }
  })();
  return done;
}
