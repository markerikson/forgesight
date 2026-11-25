import type { Database } from "bun:sqlite";
import type { OutboxOp } from "../core/state.ts";
import { GitHubApiError, NotFoundError, RateLimitedError, TokenError } from "../github/errors.ts";
import type { GitHubClient } from "../github/types.ts";
import {
  claimOutbox,
  completeOutbox,
  deferOutbox,
  dueOutbox,
  failOutbox,
  type OutboxRow,
  releaseOutbox,
  retryOutbox,
} from "../store/state-ops.ts";
import { appendChange } from "../store/views.ts";
import type { Job, JobContext } from "./scheduler.ts";

export const OUTBOX_BATCH = 20;
export const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

/** Delay before the next try after `attempts` failures. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

function send(gh: GitHubClient, op: OutboxOp, threadId: string): Promise<void> {
  switch (op) {
    case "done":
      return gh.markDone(threadId);
    case "read":
      return gh.markRead(threadId);
    case "unsubscribe":
      return gh.unsubscribe(threadId);
    case "resubscribe":
      return gh.resubscribe(threadId);
  }
}

/** Mirrors a successful write into the local thread so the next derive sees it. */
function recordSent(db: Database, row: OutboxRow, now: string): void {
  if (row.op === "done") {
    db.query("UPDATE threads SET gh_done_at = ? WHERE thread_id = ?").run(now, row.threadId);
  } else if (row.op === "read") {
    db.query("UPDATE threads SET unread = 0 WHERE thread_id = ?").run(row.threadId);
  } else {
    return;
  }
  appendChange(db, "raw", row.subjectKey, now);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Completes due rows without calling GitHub, so a scratch database can be tested against a
 * real account. Local threads are not updated, since GitHub never saw the write.
 */
function dryRun(ctx: JobContext): "worked" | "idle" {
  const { db, clock } = ctx;
  let completed = false;
  for (const row of dueOutbox(db, clock().toISOString(), OUTBOX_BATCH)) {
    const now = clock().toISOString();
    if (!claimOutbox(db, row.id, now)) continue;
    completeOutbox(db, row.id, now, "dry_run");
    ctx.log.info(`outbox dry run: would ${row.op} ${row.threadId} (${row.subjectKey})`);
    completed = true;
  }
  return completed ? "worked" : "idle";
}

/**
 * Sends queued GitHub writes (Done, read, unsubscribe, resubscribe) once their undo window
 * has passed. Rate limits and token errors release the claim and go to the scheduler; other
 * errors back off per row and give up after `MAX_ATTEMPTS`.
 */
export const outboxJob: Job = {
  name: "outbox",
  async run(ctx: JobContext) {
    const { db, gh, governor, clock } = ctx;
    if (ctx.config.outbox.dryRun) return dryRun(ctx);
    if (!governor.canSpend("rest", "writeback")) return "idle";
    let sent = false;
    for (const row of dueOutbox(db, clock().toISOString(), OUTBOX_BATCH)) {
      const now = clock().toISOString();
      if (!claimOutbox(db, row.id, now)) continue;
      try {
        // oxlint-disable-next-line no-await-in-loop -- writes go out one at a time on purpose
        await send(gh, row.op, row.threadId);
      } catch (error) {
        const failedAt = clock();
        if (error instanceof NotFoundError) {
          completeOutbox(db, row.id, failedAt.toISOString(), "not_found");
          continue;
        }
        // Status 0 is a network failure or timeout, not a rejection of this row, so it does
        // not count toward MAX_ATTEMPTS. The row still moves back in the queue so one row
        // that keeps timing out does not block the others, and the scheduler backs off.
        if (error instanceof GitHubApiError && error.status === 0) {
          const runAfter = new Date(failedAt.getTime() + backoffMs(0)).toISOString();
          deferOutbox(db, row.id, message(error), runAfter);
          throw error;
        }
        if (error instanceof RateLimitedError || error instanceof TokenError) {
          releaseOutbox(db, row.id);
          throw error;
        }
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          failOutbox(db, row.id, message(error), failedAt.toISOString());
        } else {
          const runAfter = new Date(failedAt.getTime() + backoffMs(row.attempts)).toISOString();
          retryOutbox(db, row.id, message(error), runAfter);
        }
        ctx.log.warn(`outbox ${row.op} ${row.threadId} failed: ${message(error)}`);
        continue;
      }
      const doneAt = clock().toISOString();
      db.transaction(() => {
        completeOutbox(db, row.id, doneAt);
        recordSent(db, row, doneAt);
      })();
      sent = true;
    }
    return sent ? "worked" : "idle";
  },
};
