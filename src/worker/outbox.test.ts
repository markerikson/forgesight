import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import { Governor, MemoryApiCallLog } from "../github/budget.ts";
import { GitHubApiError, NotFoundError, RateLimitedError } from "../github/errors.ts";
import { FakeGitHubClient } from "../github/fake.ts";
import { applyStateOps, outboxSummary } from "../store/state-ops.ts";
import { ensureSubjects } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { threadsForSubject, upsertThreads } from "../store/threads.ts";
import { changesAfter } from "../store/views.ts";
import { backoffMs, MAX_ATTEMPTS, outboxJob } from "./outbox.ts";
import type { JobContext, Logger } from "./scheduler.ts";

const START = new Date("2026-11-23T12:00:00.000Z");
const KEY = "octo/repo#1";
const quietLog: Logger = { info() {}, warn() {}, error() {} };

interface OutboxDbRow {
  attempts: number;
  claimed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  run_after: string;
}

let db: Database;
let now: Date;
let gh: FakeGitHubClient;
let ctx: JobContext;

const clock = () => now;

function advance(ms: number): void {
  now = new Date(now.getTime() + ms);
}

function outboxRow(): OutboxDbRow | null {
  return db
    .query<OutboxDbRow, []>(
      "SELECT attempts, claimed_at, completed_at, failed_at, last_error, run_after FROM outbox ORDER BY id LIMIT 1",
    )
    .get();
}

function seed(unread = true): void {
  ensureSubjects(db, [{ subjectKey: KEY, repo: "octo/repo", number: 1, kind: "pr", origin: "thread" }]);
  upsertThreads(
    db,
    [
      {
        threadId: "T1",
        subjectKey: KEY,
        repo: "octo/repo",
        subjectType: "PullRequest",
        reason: "review_requested",
        unread,
        updatedAt: "2026-11-23T10:00:00Z",
        lastReadAt: null,
        subjectUrl: null,
        raw: {},
      },
    ],
    START.toISOString(),
  );
}

function makeCtx(governor?: Governor): JobContext {
  const config = resolveConfig({});
  return {
    db,
    gh,
    governor: governor ?? new Governor(new MemoryApiCallLog(), config.budget, clock),
    config,
    clock,
    log: quietLog,
  };
}

beforeEach(() => {
  db = memoryDb();
  now = START;
  gh = new FakeGitHubClient(clock);
  seed();
  ctx = makeCtx();
});

describe("outboxJob", () => {
  test("waits out the undo window before sending", async () => {
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(9_000);
    expect(await outboxJob.run(ctx)).toBe("idle");
    expect(gh.calls).toEqual([]);

    advance(1_000);
    expect(await outboxJob.run(ctx)).toBe("worked");
    expect(gh.calls).toEqual([{ method: "markDone", threadId: "T1" }]);
    expect(outboxRow()?.completed_at).toBe(now.toISOString());
    expect(await outboxJob.run(ctx)).toBe("idle");
  });

  test("Done sets gh_done_at and appends a raw change for derive", async () => {
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    const seqBefore = Math.max(0, ...changesAfter(db, 0).map((c) => c.seq));
    advance(10_000);
    await outboxJob.run(ctx);
    expect(threadsForSubject(db, KEY)[0]?.ghDoneAt).toBe(now.toISOString());
    expect(changesAfter(db, seqBefore)).toMatchObject([{ kind: "raw", subjectKey: KEY }]);
  });

  test("read marks the thread read on GitHub and locally", async () => {
    applyStateOps(db, [KEY], { kind: "read" }, now.toISOString());
    advance(10_000);
    await outboxJob.run(ctx);
    expect(gh.calls).toEqual([{ method: "markRead", threadId: "T1" }]);
    expect(threadsForSubject(db, KEY)[0]?.unread).toBe(false);
  });

  test("dry run completes due rows without calling GitHub or touching threads", async () => {
    ctx = { ...ctx, config: resolveConfig({ outbox: { dryRun: true } }) };
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(9_000);
    expect(await outboxJob.run(ctx)).toBe("idle");
    expect(outboxRow()?.completed_at).toBeNull();

    advance(1_000);
    expect(await outboxJob.run(ctx)).toBe("worked");
    expect(gh.calls).toEqual([]);
    expect(outboxRow()).toMatchObject({ completed_at: now.toISOString(), last_error: "dry_run" });
    expect(threadsForSubject(db, KEY)[0]?.ghDoneAt).toBeNull();
    expect(outboxSummary(db)).toEqual({ pending: 0, failed: 0, lastError: null });
  });

  test("a 404 completes the row with a note", async () => {
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(10_000);
    gh.nextError = new NotFoundError("gone");
    expect(await outboxJob.run(ctx)).toBe("idle");
    expect(outboxRow()).toMatchObject({ completed_at: now.toISOString(), last_error: "not_found" });
    expect(outboxSummary(db)).toEqual({ pending: 0, failed: 0, lastError: null });
  });

  test("other errors back off and release the claim", async () => {
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(10_000);
    gh.nextError = new GitHubApiError("boom", 500);
    await outboxJob.run(ctx);
    expect(outboxRow()).toMatchObject({
      attempts: 1,
      claimed_at: null,
      completed_at: null,
      last_error: "boom",
      run_after: new Date(now.getTime() + backoffMs(0)).toISOString(),
    });
    expect(outboxSummary(db)).toEqual({ pending: 1, failed: 0, lastError: "boom" });

    advance(backoffMs(0) - 1);
    await outboxJob.run(ctx);
    expect(gh.calls).toHaveLength(1);
    advance(1);
    await outboxJob.run(ctx);
    expect(gh.calls).toHaveLength(2);
    expect(outboxRow()?.completed_at).toBe(now.toISOString());
  });

  test("gives up after MAX_ATTEMPTS failures", async () => {
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(10_000);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      gh.nextError = new GitHubApiError(`fail ${i}`, 500);
      // oxlint-disable-next-line no-await-in-loop
      await outboxJob.run(ctx);
      advance(backoffMs(i));
    }
    expect(gh.calls).toHaveLength(MAX_ATTEMPTS);
    expect(outboxRow()).toMatchObject({ attempts: MAX_ATTEMPTS, completed_at: null });
    expect(outboxRow()?.failed_at).not.toBeNull();
    expect(outboxSummary(db)).toEqual({ pending: 0, failed: 1, lastError: `fail ${MAX_ATTEMPTS - 1}` });
    advance(60 * 60_000);
    await outboxJob.run(ctx);
    expect(gh.calls).toHaveLength(MAX_ATTEMPTS);
  });

  test("a rate limit releases the claim and rethrows", async () => {
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(10_000);
    gh.nextError = new RateLimitedError("slow down", null, true);
    await expect(outboxJob.run(ctx)).rejects.toBeInstanceOf(RateLimitedError);
    expect(outboxRow()).toMatchObject({ attempts: 0, claimed_at: null, completed_at: null });
    expect(await outboxJob.run(ctx)).toBe("worked");
  });

  test("a network failure defers the row without counting an attempt", async () => {
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(10_000);
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      gh.nextError = new GitHubApiError("mark thread T1 done: fetch failed", 0);
      // oxlint-disable-next-line no-await-in-loop -- each run depends on the previous one
      await expect(outboxJob.run(ctx)).rejects.toBeInstanceOf(GitHubApiError);
      expect(outboxRow()).toMatchObject({
        attempts: 0,
        claimed_at: null,
        failed_at: null,
        last_error: "mark thread T1 done: fetch failed",
        run_after: new Date(now.getTime() + backoffMs(0)).toISOString(),
      });
      // oxlint-disable-next-line no-await-in-loop -- each run depends on the previous one
      expect(await outboxJob.run(ctx)).toBe("idle");
      advance(backoffMs(0));
    }
    expect(await outboxJob.run(ctx)).toBe("worked");
  });

  test("a row that keeps timing out does not block rows behind it", async () => {
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(1_000);
    applyStateOps(db, [KEY], { kind: "unsubscribe" }, now.toISOString());
    advance(10_000);
    gh.nextError = new GitHubApiError("mark thread T1 done: timed out", 0);
    await expect(outboxJob.run(ctx)).rejects.toBeInstanceOf(GitHubApiError);
    expect(await outboxJob.run(ctx)).toBe("worked");
    expect(gh.calls).toEqual([
      { method: "markDone", threadId: "T1" },
      { method: "unsubscribe", threadId: "T1" },
    ]);
  });

  test("still sends when the hourly REST cap is spent", async () => {
    const log = new MemoryApiCallLog();
    const governor = new Governor(log, { graphqlPerHour: 100, restPerHour: 1 }, clock);
    governor.record({
      at: now,
      resource: "rest",
      workClass: "notifications",
      request: "GET /notifications",
      status: 200,
      cost: null,
      remaining: null,
      resetAt: null,
      durationMs: 5,
    });
    expect(governor.canSpend("rest", "backfill")).toBe(false);
    applyStateOps(db, [KEY], { kind: "done" }, now.toISOString());
    advance(10_000);
    expect(await outboxJob.run(makeCtx(governor))).toBe("worked");
  });
});
