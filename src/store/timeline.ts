import type { Database } from "bun:sqlite";
import type {
  ReviewThreadRecord,
  StickyCommentVersion,
  TimelineItemRecord,
} from "../core/types.ts";
import {
  jsonList,
  type ReviewThreadRow,
  reviewThreadFromRow,
  stickyFromRow,
  type StickyVersionRow,
  type TimelineItemRow,
  timelineItemFromRow,
} from "./rows.ts";

export function timelineFor(db: Database, key: string): TimelineItemRecord[] {
  return db
    .query<TimelineItemRow, [string]>(
      "SELECT * FROM timeline_items WHERE subject_key = ? ORDER BY created_at, node_id",
    )
    .all(key)
    .map(timelineItemFromRow);
}

export function reviewThreadsFor(db: Database, key: string): ReviewThreadRecord[] {
  return db
    .query<ReviewThreadRow, [string]>(
      "SELECT * FROM review_threads WHERE subject_key = ? ORDER BY node_id",
    )
    .all(key)
    .map(reviewThreadFromRow);
}

/**
 * Every stored version of every sticky comment on the subject, ordered by when each body
 * was last seen, so a comment's current body is its last entry even after it reverts to
 * an earlier body.
 */
export function stickiesFor(db: Database, key: string): StickyCommentVersion[] {
  return db
    .query<StickyVersionRow, [string]>(
      `SELECT * FROM sticky_versions WHERE subject_key = ?
       ORDER BY last_seen_at, seen_at, comment_node_id, body_hash`,
    )
    .all(key)
    .map(stickyFromRow);
}

/** Distinct sticky comment node ids per subject. Subjects without stickies are absent. */
export function stickyNodeIds(db: Database, keys: string[]): Map<string, string[]> {
  const rows = db
    .query<{ subject_key: string; comment_node_id: string }, [string]>(
      `SELECT DISTINCT subject_key, comment_node_id FROM sticky_versions
       WHERE subject_key IN (SELECT value FROM json_each(?))
       ORDER BY subject_key, comment_node_id`,
    )
    .all(jsonList(keys));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.subject_key);
    if (list) list.push(r.comment_node_id);
    else out.set(r.subject_key, [r.comment_node_id]);
  }
  return out;
}

/** Stored timeline item count per typename, per subject. Subjects without items are absent. */
export function timelineCounts(db: Database, keys: string[]): Map<string, Map<string, number>> {
  const rows = db
    .query<{ subject_key: string; typename: string; n: number }, [string]>(
      `SELECT subject_key, typename, COUNT(*) AS n FROM timeline_items
       WHERE subject_key IN (SELECT value FROM json_each(?))
       GROUP BY subject_key, typename ORDER BY subject_key, n DESC, typename`,
    )
    .all(jsonList(keys));
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const counts = out.get(r.subject_key) ?? new Map<string, number>();
    counts.set(r.typename, r.n);
    out.set(r.subject_key, counts);
  }
  return out;
}
