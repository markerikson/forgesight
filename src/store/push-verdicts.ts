import type { Database } from "bun:sqlite";
import type { RebaseMethod } from "../core/config.ts";
import { ontoBranch, type PushVerdict, type PushVerdictKind } from "../core/rebase/patch.ts";
import type { BasePush } from "../core/rebase/select.ts";

export interface QueuedPush {
  pushNodeId: string;
  subjectKey: string;
  beforeSha: string;
  afterSha: string;
}

export interface PendingPush extends QueuedPush {
  attempts: number;
}

export interface DecidedVerdict {
  verdict: Exclude<PushVerdictKind, "pending">;
  reason: string | null;
  baseBefore: string | null;
  baseAfter: string | null;
}

interface PendingRow {
  push_node_id: string;
  subject_key: string;
  before_sha: string;
  after_sha: string;
  attempts: number;
}

/** Adds a pending row for each push that has none. Existing rows are left alone. */
export function queuePushes(db: Database, pushes: QueuedPush[], method: RebaseMethod, now: string): number {
  const insert = db.query(
    `INSERT INTO push_verdicts (push_node_id, subject_key, before_sha, after_sha, verdict, method, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (push_node_id) DO NOTHING`,
  );
  let added = 0;
  db.transaction(() => {
    for (const p of pushes) {
      added += insert.run(p.pushNodeId, p.subjectKey, p.beforeSha, p.afterSha, method, now).changes;
    }
  })();
  return added;
}

export interface UnqueuedPush extends QueuedPush {
  repo: string;
}

/** Head force-pushes of open PRs that have no verdict row yet. */
export function unqueuedPushes(db: Database): UnqueuedPush[] {
  return db
    .query<{ push_node_id: string; subject_key: string; repo: string; before_sha: string; after_sha: string }, []>(
      `SELECT t.node_id AS push_node_id, t.subject_key, s.repo,
              json_extract(t.raw_json, '$.beforeCommit.oid') AS before_sha,
              json_extract(t.raw_json, '$.afterCommit.oid') AS after_sha
       FROM timeline_items t
       JOIN subjects s ON s.subject_key = t.subject_key
       LEFT JOIN push_verdicts pv ON pv.push_node_id = t.node_id
       WHERE t.typename = 'HeadRefForcePushedEvent' AND s.kind = 'pr' AND s.state = 'OPEN'
         AND pv.push_node_id IS NULL
         AND json_extract(t.raw_json, '$.beforeCommit.oid') IS NOT NULL
         AND json_extract(t.raw_json, '$.afterCommit.oid') IS NOT NULL
       ORDER BY t.created_at`,
    )
    .all()
    .map((r) => ({
      pushNodeId: r.push_node_id,
      subjectKey: r.subject_key,
      repo: r.repo,
      beforeSha: r.before_sha,
      afterSha: r.after_sha,
    }));
}

/**
 * Force-pushes to each of `refs`, taken from the timelines of the repo's PRs whose head branch it
 * is, oldest first.
 */
export function branchPushes(db: Database, repo: string, refs: string[]): Map<string, BasePush[]> {
  const rows = db
    .query<{ head_ref: string; created_at: string; before_sha: string; after_sha: string }, [string, string]>(
      `SELECT s.head_ref, t.created_at,
              json_extract(t.raw_json, '$.beforeCommit.oid') AS before_sha,
              json_extract(t.raw_json, '$.afterCommit.oid') AS after_sha
       FROM timeline_items t
       JOIN subjects s ON s.subject_key = t.subject_key
       WHERE t.typename = 'HeadRefForcePushedEvent' AND s.repo = ?
         AND s.head_ref IN (SELECT value FROM json_each(?))
         AND json_extract(t.raw_json, '$.beforeCommit.oid') IS NOT NULL
         AND json_extract(t.raw_json, '$.afterCommit.oid') IS NOT NULL
       ORDER BY t.created_at, t.node_id`,
    )
    .all(repo, JSON.stringify(refs));
  const byRef = new Map<string, BasePush[]>();
  for (const r of rows) {
    const list = byRef.get(r.head_ref) ?? [];
    list.push({ at: r.created_at, before: r.before_sha, after: r.after_sha });
    byRef.set(r.head_ref, list);
  }
  return byRef;
}

/** Push node ids among `ids` that already have a row. */
export function knownPushes(db: Database, ids: string[]): Set<string> {
  const rows = db
    .query<{ push_node_id: string }, [string]>(
      "SELECT push_node_id FROM push_verdicts WHERE push_node_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(ids));
  return new Set(rows.map((r) => r.push_node_id));
}

/** Pending pushes that are due, PRs authored by `me` first, then the newest push. */
export function nextPending(db: Database, now: string, limit: number, me: string | null): PendingPush[] {
  return db
    .query<PendingRow, [string | null, string, number]>(
      `SELECT pv.push_node_id, pv.subject_key, pv.before_sha, pv.after_sha, pv.attempts
       FROM push_verdicts pv
       LEFT JOIN subjects s ON s.subject_key = pv.subject_key
       LEFT JOIN timeline_items t ON t.node_id = pv.push_node_id
       WHERE pv.verdict = 'pending' AND (pv.next_attempt_at IS NULL OR pv.next_attempt_at <= ?2)
       ORDER BY (s.author IS NOT NULL AND s.author = ?1) DESC, t.created_at DESC, pv.push_node_id
       LIMIT ?3`,
    )
    .all(me, now, limit)
    .map((r) => ({
      pushNodeId: r.push_node_id,
      subjectKey: r.subject_key,
      beforeSha: r.before_sha,
      afterSha: r.after_sha,
      attempts: r.attempts,
    }));
}

export function saveVerdict(db: Database, pushNodeId: string, result: DecidedVerdict, now: string): void {
  db.query(
    `UPDATE push_verdicts SET verdict = ?, reason = ?, base_before = ?, base_after = ?,
       attempts = attempts + 1, next_attempt_at = NULL, decided_at = ?
     WHERE push_node_id = ?`,
  ).run(result.verdict, result.reason, result.baseBefore, result.baseAfter, now, pushNodeId);
}

/** Leaves the push pending and counts the failed attempt. */
export function deferVerdict(db: Database, pushNodeId: string, nextAttemptAt: string, reason: string): void {
  db.query(
    `UPDATE push_verdicts SET attempts = attempts + 1, next_attempt_at = ?, reason = ?
     WHERE push_node_id = ?`,
  ).run(nextAttemptAt, reason, pushNodeId);
}

/** Verdicts for a subject's pushes, keyed by the SHA each push moved the head to. */
export function verdictsFor(db: Database, subjectKey: string): Map<string, PushVerdict> {
  const rows = db
    .query<{ after_sha: string; verdict: PushVerdictKind; reason: string | null; base_after: string | null }, [string]>(
      "SELECT after_sha, verdict, reason, base_after FROM push_verdicts WHERE subject_key = ?",
    )
    .all(subjectKey);
  return new Map(
    rows.map((r) => [r.after_sha, { verdict: r.verdict, reason: r.reason, onto: ontoBranch(r.base_after) }]),
  );
}

/** Row counts by verdict, for `inspect`. */
export function verdictCounts(db: Database): Record<string, number> {
  const rows = db
    .query<{ verdict: string; n: number }, []>("SELECT verdict, COUNT(*) AS n FROM push_verdicts GROUP BY verdict")
    .all();
  return Object.fromEntries(rows.map((r) => [r.verdict, r.n]));
}
