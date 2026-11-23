import type { Database } from "bun:sqlite";
import type { EnrichmentResult, SubjectRecord } from "../core/types.ts";
import { bool, jsonList, subjectFromRow, type SubjectRow, toJson } from "./rows.ts";
import { appendChange } from "./views.ts";

/** After this many failed enrichments in a row, the subject leaves the dirty queue. */
export const MAX_ENRICH_ATTEMPTS = 3;

export type NewSubject = Pick<SubjectRecord, "subjectKey" | "repo" | "number" | "kind" | "origin">;

/** Inserts subjects that are not stored yet. Existing rows are left unchanged. */
export function ensureSubjects(db: Database, subjects: NewSubject[]): void {
  const insert = db.query(
    `INSERT INTO subjects (subject_key, repo, number, kind, origin) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (subject_key) DO NOTHING`,
  );
  db.transaction(() => {
    for (const s of subjects) insert.run(s.subjectKey, s.repo, s.number, s.kind, s.origin);
  })();
}

/**
 * Queues stored subjects for enrichment. An already-dirty subject keeps its older `dirty_at`
 * and the higher priority. Resets the error count so the subject gets fresh attempts.
 */
export function markDirty(db: Database, keys: string[], now: string, priority = 0): void {
  db.query(
    `UPDATE subjects SET
       priority = CASE WHEN dirty_at IS NULL THEN ?1 ELSE MAX(priority, ?1) END,
       dirty_at = COALESCE(dirty_at, ?2),
       enrich_attempts = 0
     WHERE subject_key IN (SELECT value FROM json_each(?3))`,
  ).run(priority, now, jsonList(keys));
}

/**
 * Dirty subjects by highest priority, then oldest `dirty_at`, all from one repo:
 * `opts.repo` when given, otherwise the repo of the first subject in that order.
 */
export function nextDirtyBatch(
  db: Database,
  opts: { limit: number; repo?: string },
): SubjectRecord[] {
  const repo =
    opts.repo ??
    db
      .query<{ repo: string }, []>(
        `SELECT repo FROM subjects WHERE dirty_at IS NOT NULL
         ORDER BY priority DESC, dirty_at, subject_key LIMIT 1`,
      )
      .get()?.repo;
  if (repo === undefined) return [];
  return db
    .query<SubjectRow, [string, number]>(
      `SELECT * FROM subjects WHERE dirty_at IS NOT NULL AND repo = ?
       ORDER BY priority DESC, dirty_at, subject_key LIMIT ?`,
    )
    .all(repo, opts.limit)
    .map(subjectFromRow);
}

function bodyHash(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

/**
 * Writes one subject's enrichment in a single transaction: subject columns and raw payload,
 * new timeline items, the review thread set (when fetched), new sticky versions, cleared
 * dirty state, and a `raw` change row so derive recomputes the subject.
 * Throws if the subject is not stored. Nests inside a caller's transaction.
 */
export function saveEnrichment(db: Database, result: EnrichmentResult, now: string): void {
  const key = result.subjectKey;
  const s = result.subject;
  db.transaction(() => {
    const updated = db
      .query(
        `UPDATE subjects SET
           node_id = ?, state = ?, author = ?, head_ref = ?, base_ref = ?, head_sha = ?,
           base_sha = ?, updated_at = ?, raw_json = ?,
           timeline_synced_until = COALESCE(?, timeline_synced_until),
           dirty_at = NULL, priority = 0, enrich_error = NULL, enrich_attempts = 0
         WHERE subject_key = ?`,
      )
      .run(
        s.nodeId,
        s.state,
        s.author,
        s.headRef,
        s.baseRef,
        s.headSha,
        s.baseSha,
        s.updatedAt,
        toJson(s.raw),
        result.timelineSyncedUntil,
        key,
      );
    if (updated.changes === 0) throw new Error(`saveEnrichment: unknown subject ${key}`);

    const insertItem = db.query(
      `INSERT INTO timeline_items (node_id, subject_key, typename, created_at, raw_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (node_id) DO NOTHING`,
    );
    for (const item of result.timelineItems) {
      insertItem.run(item.nodeId, key, item.typename, item.createdAt, toJson(item.raw), now);
    }

    if (result.reviewThreads) {
      db.query("DELETE FROM review_threads WHERE subject_key = ?").run(key);
      const insertThread = db.query(
        `INSERT OR REPLACE INTO review_threads
           (node_id, subject_key, is_resolved, is_outdated, path, line, raw_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const t of result.reviewThreads) {
        insertThread.run(
          t.nodeId,
          key,
          bool(t.isResolved),
          bool(t.isOutdated),
          t.path,
          t.line,
          toJson(t.raw),
          now,
        );
      }
    }

    const insertSticky = db.query(
      `INSERT INTO sticky_versions
         (comment_node_id, body_hash, subject_key, author, last_edited_at, seen_at, body)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    for (const c of result.stickies) {
      insertSticky.run(c.commentNodeId, bodyHash(c.body), key, c.author, c.lastEditedAt, now, c.body);
    }

    appendChange(db, "raw", key, now);
  })();
}

/**
 * Records a failed enrichment. Below the attempt limit the subject stays dirty with
 * `dirty_at = now`, moving it behind older work of the same priority; at the limit it
 * leaves the queue until the next `markDirty`.
 */
export function recordEnrichError(db: Database, key: string, error: string, now: string): void {
  db.query(
    `UPDATE subjects SET
       enrich_error = ?1,
       enrich_attempts = enrich_attempts + 1,
       dirty_at = CASE WHEN enrich_attempts + 1 >= ?2 THEN NULL ELSE ?3 END
     WHERE subject_key = ?4`,
  ).run(error, MAX_ENRICH_ATTEMPTS, now, key);
}

export function getSubject(db: Database, key: string): SubjectRecord | undefined {
  const row = db.query<SubjectRow, [string]>("SELECT * FROM subjects WHERE subject_key = ?").get(key);
  return row ? subjectFromRow(row) : undefined;
}
