import type { Database } from "bun:sqlite";
import {
  applyStateOp,
  type OutboxOp,
  type OutboxThread,
  outboxOpFor,
  outboxThreads,
  type StateOp,
} from "../core/state.ts";
import type { ItemState, SubjectKey } from "../core/types.ts";
import { DEFAULT_ITEM_STATE, getItemStates, putItemState } from "./item-state.ts";
import { jsonList, type OutboxTableRow, type StateOpRow, toJson } from "./rows.ts";
import { threadsForSubject } from "./threads.ts";

/** How long a GitHub write waits in the outbox so it can be undone. */
export const OUTBOX_DELAY_MS = 10_000;
/** A claim older than this belongs to a worker that died mid-call; the row is due again. */
export const STALE_CLAIM_MS = 2 * 60_000;

export interface OutboxRow {
  id: number;
  stateOpId: number;
  op: OutboxOp;
  threadId: string;
  subjectKey: SubjectKey;
  createdAt: string;
  runAfter: string;
  claimedAt: string | null;
  attempts: number;
  lastError: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

export interface ApplyResult {
  opId: number;
  outboxIds: number[];
}

export type UndoResult =
  /** `githubApplied`: outbox rows already sent or in flight, which cannot be recalled. */
  | { kind: "undone"; githubApplied: number }
  /** A newer op touched one of the keys. */
  | { kind: "superseded" }
  | { kind: "notFound" }
  | { kind: "alreadyUndone" };

export interface OutboxSummary {
  pending: number;
  failed: number;
  lastError: string | null;
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function outboxFromRow(r: OutboxTableRow): OutboxRow {
  return {
    id: r.id,
    stateOpId: r.state_op_id,
    op: r.op as OutboxOp,
    threadId: r.thread_id,
    subjectKey: r.subject_key,
    createdAt: r.created_at,
    runAfter: r.run_after,
    claimedAt: r.claimed_at,
    attempts: r.attempts,
    lastError: r.last_error,
    completedAt: r.completed_at,
    failedAt: r.failed_at,
  };
}

/** `dismissedAt` from before the newest live `read` op on `key`; undefined when there is none. */
function dismissedBeforeRead(db: Database, key: string): string | null | undefined {
  const found = db
    .query<{ state: string }, [string]>(
      `SELECT e.value AS state FROM state_ops s, json_each(s.prev_json) e
       WHERE s.undone_at IS NULL AND json_extract(s.op_json, '$.kind') = 'read' AND e.key = ?
       ORDER BY s.id DESC LIMIT 1`,
    )
    .get(key);
  return found ? (JSON.parse(found.state) as ItemState).dismissedAt : undefined;
}

/** Threads whose newest unsubscribe/resubscribe outbox row is an unsubscribe that did not fail. */
function unsubscribedThreads(db: Database, key: string): Set<string> {
  const rows = db
    .query<{ thread_id: string; op: string }, [string]>(
      `SELECT thread_id, op FROM outbox o
       WHERE subject_key = ? AND failed_at IS NULL AND op IN ('unsubscribe', 'resubscribe')
         AND id = (SELECT MAX(id) FROM outbox p WHERE p.thread_id = o.thread_id
                   AND p.failed_at IS NULL AND p.op IN ('unsubscribe', 'resubscribe'))`,
    )
    .all(key);
  return new Set(rows.filter((r) => r.op === "unsubscribe").map((r) => r.thread_id));
}

function outboxTargets(db: Database, key: string, op: OutboxOp): string[] {
  const unsubscribed = op === "resubscribe" ? unsubscribedThreads(db, key) : new Set<string>();
  const threads: OutboxThread[] = threadsForSubject(db, key).map((t) => ({
    threadId: t.threadId,
    unread: t.unread,
    ghDoneAt: t.ghDoneAt,
    unsubscribed: unsubscribed.has(t.threadId),
  }));
  return outboxThreads(op, threads);
}

/**
 * Applies `op` to every key in one transaction: records the op with the states it
 * replaces, writes the new states (each appends a `state` change), and queues GitHub
 * writes for the subjects' notification threads. Subjects without threads queue nothing.
 */
export function applyStateOps(db: Database, keys: SubjectKey[], op: StateOp, now: string): ApplyResult {
  const unique = [...new Set(keys)];
  return db.transaction(() => {
    const stored = getItemStates(db, unique);
    const prev: Record<SubjectKey, ItemState> = {};
    for (const key of unique) prev[key] = stored.get(key) ?? { ...DEFAULT_ITEM_STATE };

    const opId = Number(
      db
        .query("INSERT INTO state_ops (created_at, op_json, prev_json) VALUES (?, ?, ?)")
        .run(now, toJson(op), toJson(prev)).lastInsertRowid,
    );
    const insertOutbox = db.query(
      `INSERT INTO outbox (state_op_id, op, thread_id, subject_key, created_at, run_after)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const runAfter = addMs(now, OUTBOX_DELAY_MS);
    const outboxIds: number[] = [];
    for (const key of unique) {
      const before = prev[key] ?? { ...DEFAULT_ITEM_STATE };
      const opts = op.kind === "unread" ? { dismissedBeforeRead: dismissedBeforeRead(db, key) } : {};
      putItemState(db, key, applyStateOp(before, op, now, opts), now);
      const outboxOp = outboxOpFor(op, before);
      if (outboxOp === null) continue;
      for (const threadId of outboxTargets(db, key, outboxOp)) {
        const id = insertOutbox.run(opId, outboxOp, threadId, key, now, runAfter).lastInsertRowid;
        outboxIds.push(Number(id));
      }
    }
    return { opId, outboxIds };
  })();
}

/**
 * Reverts an op in one transaction: drops its unsent outbox rows and restores the item
 * states it replaced. Refuses when a newer live op touched any of its keys.
 */
export function undoStateOp(db: Database, opId: number, now: string): UndoResult {
  return db.transaction((): UndoResult => {
    const op = db.query<StateOpRow, [number]>("SELECT * FROM state_ops WHERE id = ?").get(opId);
    if (!op) return { kind: "notFound" };
    if (op.undone_at !== null) return { kind: "alreadyUndone" };
    const prev = JSON.parse(op.prev_json) as Record<SubjectKey, ItemState>;
    const keys = Object.keys(prev);
    const newer = db
      .query<{ id: number }, [number, string]>(
        `SELECT s.id FROM state_ops s
         WHERE s.id > ? AND s.undone_at IS NULL
           AND EXISTS (SELECT 1 FROM json_each(s.prev_json) e
                       WHERE e.key IN (SELECT value FROM json_each(?)))
         LIMIT 1`,
      )
      .get(opId, jsonList(keys));
    if (newer) return { kind: "superseded" };

    db.query("DELETE FROM outbox WHERE state_op_id = ? AND claimed_at IS NULL AND completed_at IS NULL").run(
      opId,
    );
    const applied = db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM outbox WHERE state_op_id = ?")
      .get(opId);
    for (const key of keys) {
      const state = prev[key];
      if (state) putItemState(db, key, state, now);
    }
    db.query("UPDATE state_ops SET undone_at = ? WHERE id = ?").run(now, opId);
    return { kind: "undone", githubApplied: applied?.n ?? 0 };
  })();
}

/**
 * Rows ready to send, oldest `run_after` first: not completed or failed, and unclaimed or
 * claimed longer than `STALE_CLAIM_MS` ago.
 */
export function dueOutbox(db: Database, now: string, limit: number): OutboxRow[] {
  return db
    .query<OutboxTableRow, [string, string, number]>(
      `SELECT * FROM outbox
       WHERE completed_at IS NULL AND failed_at IS NULL AND run_after <= ?
         AND (claimed_at IS NULL OR claimed_at <= ?)
       ORDER BY run_after, id LIMIT ?`,
    )
    .all(now, addMs(now, -STALE_CLAIM_MS), limit)
    .map(outboxFromRow);
}

/**
 * Claims a row just before its GitHub call. False when undo deleted it, it finished, or
 * another live claim holds it; the caller then skips the row.
 */
export function claimOutbox(db: Database, id: number, now: string): boolean {
  const result = db
    .query(
      `UPDATE outbox SET claimed_at = ?
       WHERE id = ? AND completed_at IS NULL AND failed_at IS NULL
         AND (claimed_at IS NULL OR claimed_at <= ?)`,
    )
    .run(now, id, addMs(now, -STALE_CLAIM_MS));
  return result.changes > 0;
}

/** Drops a claim without counting an attempt (rate limit, token error). */
export function releaseOutbox(db: Database, id: number): void {
  db.query("UPDATE outbox SET claimed_at = NULL WHERE id = ? AND completed_at IS NULL").run(id);
}

/** Marks a row sent. `note` (e.g. `not_found`) is kept in `last_error`. */
export function completeOutbox(db: Database, id: number, now: string, note?: string): void {
  db.query("UPDATE outbox SET completed_at = ?, last_error = COALESCE(?, last_error) WHERE id = ?").run(
    now,
    note ?? null,
    id,
  );
}

/** Counts a failed attempt, releases the claim, and pushes the row out to `runAfter`. */
export function retryOutbox(db: Database, id: number, error: string, runAfter: string): void {
  db.query(
    `UPDATE outbox SET attempts = attempts + 1, last_error = ?, run_after = ?, claimed_at = NULL
     WHERE id = ?`,
  ).run(error, runAfter, id);
}

/** Gives up on a row; it stays for the status panel until a later cleanup. */
export function failOutbox(db: Database, id: number, error: string, now: string): void {
  db.query(
    `UPDATE outbox SET attempts = attempts + 1, last_error = ?, failed_at = ?, claimed_at = NULL
     WHERE id = ?`,
  ).run(error, now, id);
}

/** Waiting and failed row counts, and the newest error among them. */
export function outboxSummary(db: Database): OutboxSummary {
  const counts = db
    .query<{ pending: number; failed: number }, []>(
      `SELECT
         COALESCE(SUM(completed_at IS NULL AND failed_at IS NULL), 0) AS pending,
         COALESCE(SUM(failed_at IS NOT NULL), 0) AS failed
       FROM outbox`,
    )
    .get();
  const error = db
    .query<{ last_error: string }, []>(
      `SELECT last_error FROM outbox
       WHERE completed_at IS NULL AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get();
  return { pending: counts?.pending ?? 0, failed: counts?.failed ?? 0, lastError: error?.last_error ?? null };
}

/**
 * Deletes completed outbox rows and state ops created before `before`. Failed rows stay,
 * and so do the ops they belong to.
 */
export function pruneStateOps(db: Database, before: string): { outbox: number; stateOps: number } {
  return db.transaction(() => {
    const outbox = db
      .query("DELETE FROM outbox WHERE completed_at IS NOT NULL AND created_at < ?")
      .run(before).changes;
    const stateOps = db
      .query(
        `DELETE FROM state_ops WHERE created_at < ?
         AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.state_op_id = state_ops.id)`,
      )
      .run(before).changes;
    return { outbox, stateOps };
  })();
}
