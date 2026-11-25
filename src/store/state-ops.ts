import type { Database } from "bun:sqlite";
import {
  applyStateOp,
  cancelledOutboxOp,
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
import { parseWorkstreamOpRecord, restoreWorkstreamOp } from "./workstream-ops.ts";

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

/**
 * SQL condition on an outbox row (aliased `alias`): its op has not been undone, and no live
 * op cancelled it. Undoing the cancelling op makes the row live again.
 */
function liveOp(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM state_ops s WHERE s.id = ${alias}.state_op_id AND s.undone_at IS NOT NULL)
    AND (${alias}.cancelled_by IS NULL
         OR EXISTS (SELECT 1 FROM state_ops c WHERE c.id = ${alias}.cancelled_by AND c.undone_at IS NOT NULL))`;
}

/**
 * Cancels `key`'s unsent, unclaimed `op` rows on behalf of state op `opId`. A row already
 * claimed is in flight and goes out anyway.
 */
function cancelQueued(db: Database, key: string, op: OutboxOp, opId: number): number {
  return db
    .query(
      `UPDATE outbox SET cancelled_by = ?
       WHERE subject_key = ? AND op = ? AND claimed_at IS NULL AND completed_at IS NULL
         AND failed_at IS NULL AND ${liveOp("outbox")}`,
    )
    .run(opId, key, op).changes;
}

/**
 * `dismissedAt` from before the newest live op on `key` that set it, when that op is a
 * `read`. Undefined otherwise, so a later done or unread is not rolled back.
 */
function dismissedBeforeRead(db: Database, key: string, beforeOpId: number): string | null | undefined {
  const found = db
    .query<{ kind: string; state: string }, [number, string]>(
      `SELECT json_extract(s.op_json, '$.kind') AS kind, e.value AS state
       FROM state_ops s, json_each(s.prev_json) e
       WHERE s.id < ? AND s.undone_at IS NULL AND e.key = ?
         AND json_extract(s.op_json, '$.kind') IN ('read', 'done', 'unread')
       ORDER BY s.id DESC LIMIT 1`,
    )
    .get(beforeOpId, key);
  if (found?.kind !== "read") return undefined;
  return (JSON.parse(found.state) as ItemState).dismissedAt;
}

/**
 * Threads whose newest unsubscribe/resubscribe outbox row is an unsubscribe that did not
 * fail. Unsent rows of undone ops never go out, so they don't count.
 */
function unsubscribedThreads(db: Database, key: string): Set<string> {
  const counts = (alias: string) =>
    `${alias}.failed_at IS NULL AND ${alias}.op IN ('unsubscribe', 'resubscribe')
     AND (${alias}.completed_at IS NOT NULL OR ${liveOp(alias)})`;
  const rows = db
    .query<{ thread_id: string; op: string }, [string]>(
      `SELECT thread_id, op FROM outbox o
       WHERE o.subject_key = ? AND ${counts("o")}
         AND o.id = (SELECT MAX(id) FROM outbox p WHERE p.thread_id = o.thread_id AND ${counts("p")})`,
    )
    .all(key);
  return new Set(rows.filter((r) => r.op === "unsubscribe").map((r) => r.thread_id));
}

/**
 * Threads of `key` whose newest live write of `op`'s family is an unsent `op` row. Unsubscribe
 * and resubscribe form one family, so a pending opposite write queued later is not skipped.
 */
function queuedThreads(db: Database, key: string, op: OutboxOp): Set<string> {
  const subscription = op === "unsubscribe" || op === "resubscribe";
  const [a, b] = subscription ? (["unsubscribe", "resubscribe"] as const) : [op, op];
  const counts = (alias: string) =>
    `${alias}.failed_at IS NULL AND ${alias}.op IN (?, ?)
     AND (${alias}.completed_at IS NOT NULL OR ${liveOp(alias)})`;
  const rows = db
    .query<{ thread_id: string }, [string, string, string, string, string, string]>(
      `SELECT thread_id FROM outbox o
       WHERE o.subject_key = ? AND o.op = ? AND o.completed_at IS NULL AND ${counts("o")}
         AND o.id = (SELECT MAX(id) FROM outbox p WHERE p.thread_id = o.thread_id AND ${counts("p")})`,
    )
    .all(key, op, a, b, a, b);
  return new Set(rows.map((r) => r.thread_id));
}

/**
 * Threads that get an `op` row. A thread that already has the same write waiting is skipped,
 * so repeating an op before the outbox sends it does not queue the write twice.
 */
function outboxTargets(db: Database, key: string, op: OutboxOp): string[] {
  const unsubscribed = op === "resubscribe" ? unsubscribedThreads(db, key) : new Set<string>();
  const queued = queuedThreads(db, key, op);
  const threads: OutboxThread[] = threadsForSubject(db, key)
    .filter((t) => !queued.has(t.threadId))
    .map((t) => ({
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
      const opts = op.kind === "unread" ? { dismissedBeforeRead: dismissedBeforeRead(db, key, opId) } : {};
      putItemState(db, key, applyStateOp(before, op, now, opts), now);
      const cancelled = cancelledOutboxOp(op, before);
      if (cancelled !== null) cancelQueued(db, key, cancelled, opId);
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
 * states it replaced. Refuses when a newer live op touched any of its keys. A newer
 * workstream `seen` op does not block it: undo keeps that op's seen fields instead.
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
           AND json_extract(s.op_json, '$.op.kind') IS NOT 'seen'
           AND EXISTS (SELECT 1 FROM json_each(s.prev_json) e
                       WHERE e.key IN (SELECT value FROM json_each(?)))
         LIMIT 1`,
      )
      .get(opId, jsonList(keys));
    if (newer) return { kind: "superseded" };

    const wsRecord = parseWorkstreamOpRecord(op.op_json);
    if (wsRecord) {
      restoreWorkstreamOp(db, opId, wsRecord, op.prev_json, now);
      db.query("UPDATE state_ops SET undone_at = ? WHERE id = ?").run(now, opId);
      return { kind: "undone", githubApplied: 0 };
    }

    db.query("DELETE FROM outbox WHERE state_op_id = ? AND claimed_at IS NULL AND completed_at IS NULL").run(
      opId,
    );
    const applied = db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM outbox WHERE state_op_id = ?")
      .get(opId);
    for (const key of keys) {
      const state = prev[key];
      // Ops recorded before a field existed lack it; the default fills the gap.
      if (state) putItemState(db, key, { ...DEFAULT_ITEM_STATE, ...state }, now);
    }
    db.query("UPDATE state_ops SET undone_at = ? WHERE id = ?").run(now, opId);
    return { kind: "undone", githubApplied: applied?.n ?? 0 };
  })();
}

/**
 * Rows ready to send, oldest `run_after` first: not completed or failed, op not undone,
 * and unclaimed or claimed longer than `STALE_CLAIM_MS` ago.
 */
export function dueOutbox(db: Database, now: string, limit: number): OutboxRow[] {
  return db
    .query<OutboxTableRow, [string, string, number]>(
      `SELECT * FROM outbox
       WHERE completed_at IS NULL AND failed_at IS NULL AND run_after <= ?
         AND (claimed_at IS NULL OR claimed_at <= ?) AND ${liveOp("outbox")}
       ORDER BY run_after, id LIMIT ?`,
    )
    .all(now, addMs(now, -STALE_CLAIM_MS), limit)
    .map(outboxFromRow);
}

/**
 * Claims a row just before its GitHub call. False when its op was undone, it finished, or
 * another live claim holds it; the caller then skips the row.
 */
export function claimOutbox(db: Database, id: number, now: string): boolean {
  const result = db
    .query(
      `UPDATE outbox SET claimed_at = ?
       WHERE id = ? AND completed_at IS NULL AND failed_at IS NULL
         AND (claimed_at IS NULL OR claimed_at <= ?) AND ${liveOp("outbox")}`,
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

/**
 * Releases the claim and pushes the row out to `runAfter` without counting an attempt
 * (network failure or timeout), so one row that keeps timing out does not block the rest.
 */
export function deferOutbox(db: Database, id: number, error: string, runAfter: string): void {
  db.query("UPDATE outbox SET last_error = ?, run_after = ?, claimed_at = NULL WHERE id = ?").run(
    error,
    runAfter,
    id,
  );
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
         COALESCE(SUM(completed_at IS NULL AND failed_at IS NULL AND ${liveOp("outbox")}), 0) AS pending,
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
 * Deletes outbox rows created before `before` that were sent or belong to an undone op,
 * then state ops no row belongs to or was cancelled by. Failed rows stay, and so do the ops
 * they belong to.
 * Each thread's newest sent unsubscribe/resubscribe row stays too: unmute reads it to
 * decide whether to resubscribe.
 */
export function pruneStateOps(db: Database, before: string): { outbox: number; stateOps: number } {
  return db.transaction(() => {
    const outbox = db
      .query(
        `DELETE FROM outbox
         WHERE created_at < ? AND failed_at IS NULL
           AND (completed_at IS NOT NULL OR NOT ${liveOp("outbox")})
           AND NOT (op IN ('unsubscribe', 'resubscribe') AND completed_at IS NOT NULL
                    AND id = (SELECT MAX(id) FROM outbox p
                              WHERE p.thread_id = outbox.thread_id AND p.completed_at IS NOT NULL
                                AND p.failed_at IS NULL AND p.op IN ('unsubscribe', 'resubscribe')))`,
      )
      .run(before).changes;
    const stateOps = db
      .query(
        `DELETE FROM state_ops WHERE created_at < ?
         AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.state_op_id = state_ops.id)
         AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.cancelled_by = state_ops.id)`,
      )
      .run(before).changes;
    return { outbox, stateOps };
  })();
}
