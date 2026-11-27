import type { Database } from "bun:sqlite";
import { ENRICH_PRIORITY, type QueuedSubject } from "../core/enrich-plan.ts";
import type { StoredPull } from "../core/recently-closed.ts";
import type { EnrichmentResult, SubjectKind, SubjectOrigin, SubjectRecord, SubjectState } from "../core/types.ts";
import { bool, jsonList, subjectFromRow, type SubjectRow, toJson } from "./rows.ts";
import { appendChange } from "./views.ts";

/** After this many failed enrichments in a row, the subject leaves the dirty queue. */
export const MAX_ENRICH_ATTEMPTS = 3;

export type NewSubject = Pick<SubjectRecord, "subjectKey" | "repo" | "number" | "kind" | "origin">;

/**
 * Inserts subjects that are not stored yet. An existing row only changes its origin, and only
 * upward in precedence: thread over stack over open-list.
 */
export function ensureSubjects(db: Database, subjects: NewSubject[]): void {
  const insert = db.query(
    `INSERT INTO subjects (subject_key, repo, number, kind, origin) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (subject_key) DO UPDATE SET origin = excluded.origin
     WHERE (CASE subjects.origin WHEN 'thread' THEN 3 WHEN 'stack' THEN 2 ELSE 1 END)
         < (CASE excluded.origin WHEN 'thread' THEN 3 WHEN 'stack' THEN 2 ELSE 1 END)`,
  );
  db.transaction(() => {
    for (const s of subjects) insert.run(s.subjectKey, s.repo, s.number, s.kind, s.origin);
  })();
}

/**
 * Queues stored subjects for enrichment. An already-dirty subject keeps its older `dirty_at`
 * and the higher priority, and keeps its error count so retries still stop at
 * MAX_ENRICH_ATTEMPTS. A subject that was not dirty starts with a fresh count.
 */
export function markDirty(db: Database, keys: string[], now: string, priority = 0): void {
  db.query(
    `UPDATE subjects SET
       priority = CASE WHEN dirty_at IS NULL THEN ?1 ELSE MAX(priority, ?1) END,
       enrich_attempts = CASE WHEN dirty_at IS NULL THEN 0 ELSE enrich_attempts END,
       dirty_at = COALESCE(dirty_at, ?2)
     WHERE subject_key IN (SELECT value FROM json_each(?3))`,
  ).run(priority, now, jsonList(keys));
}

interface QueueRow {
  subject_key: string;
  repo: string;
  kind: SubjectKind;
  state: SubjectState | null;
  origin: SubjectOrigin;
  priority: number;
  dirty_at: string;
  thread_updated_at: string | null;
}

/**
 * Every dirty subject with its newest notification update, without the stored payload.
 * `minPriority` limits the queue to subjects at or above that priority.
 */
export function dirtyQueue(db: Database, minPriority = 0): QueuedSubject[] {
  return db
    .query<QueueRow, [number]>(
      `SELECT s.subject_key, s.repo, s.kind, s.state, s.origin, s.priority, s.dirty_at,
              (SELECT MAX(t.updated_at) FROM threads t WHERE t.subject_key = s.subject_key) AS thread_updated_at
       FROM subjects s WHERE s.dirty_at IS NOT NULL AND s.priority >= ?`,
    )
    .all(minPriority)
    .map((r) => ({
      subjectKey: r.subject_key,
      repo: r.repo,
      kind: r.kind,
      state: r.state,
      origin: r.origin,
      priority: r.priority,
      dirtyAt: r.dirty_at,
      threadUpdatedAt: r.thread_updated_at,
    }));
}

/** Stored subjects for `keys`, in the order of `keys`. Unknown keys are skipped. */
export function subjectsByKeys(db: Database, keys: string[]): SubjectRecord[] {
  const rows = db
    .query<SubjectRow, [string]>("SELECT * FROM subjects WHERE subject_key IN (SELECT value FROM json_each(?))")
    .all(jsonList(keys));
  const byKey = new Map(rows.map((r) => [r.subject_key, subjectFromRow(r)]));
  return keys.flatMap((key) => byKey.get(key) ?? []);
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
         (comment_node_id, body_hash, subject_key, author, last_edited_at, seen_at, last_seen_at, body)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
       ON CONFLICT (comment_node_id, body_hash) DO UPDATE SET
         last_seen_at = excluded.last_seen_at, last_edited_at = excluded.last_edited_at`,
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
 * leaves the queue until the next `markDirty`. An urgent subject drops out of the urgent
 * tier, so its retries wait their turn instead of running back to back.
 */
export function recordEnrichError(db: Database, key: string, error: string, now: string): void {
  db.query(
    `UPDATE subjects SET
       enrich_error = ?1,
       enrich_attempts = enrich_attempts + 1,
       priority = MIN(priority, ?5),
       dirty_at = CASE WHEN enrich_attempts + 1 >= ?2 THEN NULL ELSE ?3 END
     WHERE subject_key = ?4`,
  ).run(error, MAX_ENRICH_ATTEMPTS, now, key, ENRICH_PRIORITY.direct);
}

/** Records that GitHub no longer has the subject (deleted or no access) and takes it off the queue. */
export function recordNotFound(db: Database, key: string): void {
  db.query(
    `UPDATE subjects SET enrich_error = 'not_found', enrich_attempts = enrich_attempts + 1, dirty_at = NULL, priority = 0
     WHERE subject_key = ?`,
  ).run(key);
}

/** Takes subjects off the queue without enriching them (kinds that are never enriched). */
export function clearDirty(db: Database, keys: string[]): void {
  db.query(
    `UPDATE subjects SET dirty_at = NULL, priority = 0 WHERE subject_key IN (SELECT value FROM json_each(?))`,
  ).run(jsonList(keys));
}

/** Keys of dirty subjects of the given kinds. */
export function dirtyKeysOfKind(db: Database, kinds: SubjectKind[]): string[] {
  return db
    .query<{ subject_key: string }, [string]>(
      `SELECT subject_key FROM subjects
       WHERE dirty_at IS NOT NULL AND kind IN (SELECT value FROM json_each(?))`,
    )
    .all(jsonList(kinds))
    .map((r) => r.subject_key);
}

/** Number of dirty subjects. */
export function dirtyCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM subjects WHERE dirty_at IS NOT NULL").get()?.n ?? 0;
}

interface StoredPullRow {
  number: number;
  state: SubjectState;
  author: string | null;
  head_ref: string;
  base_ref: string;
  updated_at: string;
  title: string | null;
  author_type: string | null;
  is_draft: number | null;
  closed_at: string | null;
}

/** Enriched PR subjects of `repo` updated at or after `since`, as grouping input. */
export function storedPulls(db: Database, repo: string, since: string): StoredPull[] {
  return db
    .query<StoredPullRow, [string, string]>(
      `SELECT number, state, author, head_ref, base_ref, updated_at,
         json_extract(raw_json, '$.title') AS title,
         json_extract(raw_json, '$.author.__typename') AS author_type,
         json_extract(raw_json, '$.isDraft') AS is_draft,
         COALESCE(json_extract(raw_json, '$.mergedAt'), json_extract(raw_json, '$.closedAt')) AS closed_at
       FROM subjects
       WHERE repo = ? AND kind = 'pr' AND number IS NOT NULL AND state IS NOT NULL
         AND head_ref IS NOT NULL AND base_ref IS NOT NULL AND updated_at >= ?
       ORDER BY number`,
    )
    .all(repo, since)
    .map((r) => ({
      pull: {
        repo,
        number: r.number,
        title: r.title ?? "",
        author: r.author ?? "",
        ...(r.author_type ? { authorType: r.author_type } : {}),
        headRef: r.head_ref,
        baseRef: r.base_ref,
        isDraft: r.is_draft === 1,
        updatedAt: r.updated_at,
      },
      state: r.state,
      closedAt: r.closed_at,
    }));
}

export function getSubject(db: Database, key: string): SubjectRecord | undefined {
  const row = db.query<SubjectRow, [string]>("SELECT * FROM subjects WHERE subject_key = ?").get(key);
  return row ? subjectFromRow(row) : undefined;
}
