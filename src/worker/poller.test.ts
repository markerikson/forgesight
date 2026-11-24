import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import { Governor, MemoryApiCallLog } from "../github/budget.ts";
import { GitHubApiError, RateLimitedError, TokenError } from "../github/errors.ts";
import { FakeGitHubClient, fakeThread } from "../github/fake.ts";
import { getItemState } from "../store/item-state.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { getSubject } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { listThreads, threadsForSubject } from "../store/threads.ts";
import { createPoller, POLL_META } from "./poller.ts";
import { type JobContext, type Logger, Scheduler, WORKER_STATUS_KEY } from "./scheduler.ts";

const START = new Date("2026-11-23T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const quietLog: Logger = { info() {}, warn() {}, error() {} };

function ago(ms: number): string {
  return new Date(START.getTime() - ms).toISOString();
}

function setup(user: Parameters<typeof resolveConfig>[0] = {}) {
  let now = START;
  const clock = () => now;
  const db = memoryDb();
  const config = resolveConfig(user);
  const gh = new FakeGitHubClient(clock);
  const governor = new Governor(new MemoryApiCallLog(), config.budget, clock);
  const ctx: JobContext = { db, gh, governor, config, clock, log: quietLog };
  const poller = createPoller();
  const scheduler = new Scheduler(ctx, [poller.pollJob, poller.backfillJob], {
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
  });
  return {
    db,
    gh,
    ctx,
    poller,
    scheduler,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function callsOf(gh: FakeGitHubClient, method: string): number {
  return gh.calls.filter((c) => c.method === method).length;
}

describe("first run", () => {
  test("backfill stores every thread and queues only the last 14 days", async () => {
    const { db, gh, scheduler } = setup();
    gh.pageSize = 2;
    gh.setThreads(
      fakeThread({ id: "1", updatedAt: ago(HOUR), reason: "review_requested" }),
      fakeThread({ id: "2", updatedAt: ago(3 * DAY), lastReadAt: ago(4 * DAY) }),
      fakeThread({ id: "3", updatedAt: ago(20 * DAY) }),
      fakeThread({ id: "4", updatedAt: ago(60 * DAY) }),
      fakeThread({ id: "5", updatedAt: ago(400 * DAY) }),
    );

    expect(await scheduler.drain()).toBe("idle");

    expect(listThreads(db).map((t) => t.threadId)).toEqual(["1", "2", "3", "4"]);
    expect(getMeta(db, POLL_META.backfillCompletedAt)).toBeDefined();
    expect(getMeta(db, POLL_META.backfillCursor)).toBe(ago(60 * DAY));

    const recent = getSubject(db, "octo/repo#1");
    expect(recent?.dirtyAt).not.toBeNull();
    expect(recent?.priority).toBe(2);
    expect(getSubject(db, "octo/repo#2")?.dirtyAt).not.toBeNull();
    expect(getSubject(db, "octo/repo#3")?.dirtyAt).toBeNull();
    expect(getSubject(db, "octo/repo#4")?.dirtyAt).toBeNull();

    // Older than 14 days: dismissed at its last update. Newer: last_read_at, else updated − 2 days.
    expect(getItemState(db, "octo/repo#3").dismissedAt).toBe(ago(20 * DAY));
    expect(getItemState(db, "octo/repo#2").dismissedAt).toBe(ago(4 * DAY));
    expect(getItemState(db, "octo/repo#1").dismissedAt).toBe(ago(HOUR + 2 * DAY));
  });

  test("first poll takes page 1 only; later polls fetch since the last one", async () => {
    const { db, gh, poller, ctx, advance } = setup();
    gh.setThreads(fakeThread({ id: "1", updatedAt: ago(HOUR) }));

    expect(await poller.pollJob.run(ctx)).toBe("worked");
    expect(callsOf(gh, "listNotificationsSince")).toBe(0);
    expect(getMeta(db, POLL_META.etag)).toBe(gh.etag);
    expect(getMeta(db, POLL_META.lastPollStartedAt)).toBe(START.toISOString());

    advance(30_000);
    expect(await poller.pollJob.run(ctx)).toBe("idle");

    advance(30_000);
    expect(await poller.pollJob.run(ctx)).toBe("worked");
    expect(gh.calls.at(-1)).toEqual({
      method: "pollNotifications",
      opts: { etag: gh.etag, force: false },
    });
    expect(callsOf(gh, "listNotificationsSince")).toBe(0);
    // A 304 means nothing moved to page 1, so it advances the since= anchor.
    expect(getMeta(db, POLL_META.lastPollStartedAt)).toBe(new Date(START.getTime() + 60_000).toISOString());

    advance(60_000);
    gh.setThreads(fakeThread({ id: "2", updatedAt: new Date(START.getTime() + 90_000).toISOString() }));
    expect(await poller.pollJob.run(ctx)).toBe("worked");
    const since = gh.calls.find((c) => c.method === "listNotificationsSince");
    // since= counts from the 304 poll, with the 2-minute overlap.
    expect(since).toEqual({
      method: "listNotificationsSince",
      since: new Date(START.getTime() + 60_000 - 2 * 60_000),
    });
    expect(getSubject(db, "octo/repo#2")?.dirtyAt).not.toBeNull();
  });

  test("a poll before backfill applies the 14-day rule to page 1", async () => {
    const { db, gh, poller, ctx } = setup();
    gh.setThreads(fakeThread({ id: "1", updatedAt: ago(HOUR) }), fakeThread({ id: "2", updatedAt: ago(20 * DAY) }));

    expect(await poller.pollJob.run(ctx)).toBe("worked");

    expect(getSubject(db, "octo/repo#1")?.dirtyAt).not.toBeNull();
    expect(getSubject(db, "octo/repo#2")?.dirtyAt).toBeNull();
    expect(getItemState(db, "octo/repo#2").dismissedAt).toBe(ago(20 * DAY));
  });
});

describe("poll", () => {
  test("a refresh request makes the next poll due and skips the ETag", async () => {
    const { db, gh, poller, ctx, advance } = setup();
    gh.setThreads(fakeThread({ id: "1", updatedAt: ago(HOUR) }));
    await poller.pollJob.run(ctx);

    advance(1000);
    expect(await poller.pollJob.run(ctx)).toBe("idle");
    setMeta(db, POLL_META.requestedAt, new Date(START.getTime() + 1000).toISOString(), "x");
    advance(1000);
    expect(await poller.pollJob.run(ctx)).toBe("worked");
    expect(gh.calls.at(-1)).toEqual({ method: "listNotificationsSince", since: expect.any(Date) });
    expect(getMeta(db, POLL_META.lastFullAt)).toBe(new Date(START.getTime() + 2000).toISOString());

    advance(1000);
    expect(await poller.pollJob.run(ctx)).toBe("idle");
  });

  test("an in-process request forces the client past its interval", async () => {
    const { gh, poller, ctx } = setup();
    await poller.pollJob.run(ctx);
    poller.request();
    await poller.pollJob.run(ctx);
    const polls = gh.calls.filter((c) => c.method === "pollNotifications");
    expect(polls.map((c) => c.method === "pollNotifications" && c.opts.force)).toEqual([true, true]);
  });

  test("a full refresh fetches since= even when page 1 is unchanged", async () => {
    const { gh, poller, ctx, advance } = setup({ polling: { fullRefreshMinutes: 10 } });
    gh.setThreads(fakeThread({ id: "1", updatedAt: ago(HOUR) }));
    await poller.pollJob.run(ctx);
    advance(5 * 60_000);
    await poller.pollJob.run(ctx);
    expect(callsOf(gh, "listNotificationsSince")).toBe(0);
    advance(5 * 60_000);
    await poller.pollJob.run(ctx);
    expect(callsOf(gh, "listNotificationsSince")).toBe(1);
  });

  test("a read-state change is stored without queuing enrichment", async () => {
    const { db, gh, poller, ctx, advance } = setup();
    gh.setThreads(fakeThread({ id: "1", updatedAt: ago(HOUR) }));
    await poller.pollJob.run(ctx);
    db.run("UPDATE subjects SET dirty_at = NULL");

    advance(60_000);
    gh.setThreads(fakeThread({ id: "1", updatedAt: ago(HOUR), unread: false, lastReadAt: ago(0) }));
    poller.request();
    await poller.pollJob.run(ctx);
    expect(threadsForSubject(db, "octo/repo#1")[0]?.unread).toBe(false);
    expect(getSubject(db, "octo/repo#1")?.dirtyAt).toBeNull();
  });

  test("a thread whose updated_at moves comes back from GitHub done", async () => {
    const { db, gh, poller, ctx, advance } = setup();
    gh.setThreads(fakeThread({ id: "1", updatedAt: ago(HOUR) }));
    await poller.pollJob.run(ctx);
    db.run("UPDATE threads SET gh_done_at = ?", [START.toISOString()]);

    advance(60_000);
    gh.setThreads(fakeThread({ id: "1", updatedAt: START.toISOString() }));
    poller.request();
    await poller.pollJob.run(ctx);
    expect(threadsForSubject(db, "octo/repo#1")[0]?.ghDoneAt).toBeNull();
  });

  test("priority repos queue above other repos", async () => {
    const { db, gh, poller, ctx } = setup({ repos: { "octo/hot": { mode: "full" } } });
    gh.setThreads(
      fakeThread({ id: "1", repo: "octo/hot", subjectUrl: "https://api.github.com/repos/octo/hot/pulls/1" }),
      fakeThread({ id: "2" }),
      fakeThread({ id: "3", subjectType: "Release", subjectUrl: null }),
    );
    await poller.pollJob.run(ctx);
    expect(getSubject(db, "octo/hot#1")?.priority).toBe(1);
    expect(getSubject(db, "octo/repo#2")?.priority).toBe(0);
    const release = listThreads(db).find((t) => t.threadId === "3");
    expect(getSubject(db, release?.subjectKey ?? "")?.kind).toBe("other");
  });
});

describe("backfill", () => {
  test("resumes from page 1 after an error, writing only what changed", async () => {
    const { db, gh, poller, ctx } = setup();
    gh.pageSize = 1;
    gh.setThreads(
      fakeThread({ id: "1", updatedAt: ago(HOUR) }),
      fakeThread({ id: "2", updatedAt: ago(2 * HOUR) }),
    );
    expect(await poller.backfillJob.run(ctx)).toBe("worked");
    expect(listThreads(db)).toHaveLength(1);

    gh.nextError = new Error("boom");
    expect(await poller.backfillJob.run(ctx)).toBe("worked");
    // The generator already ran past its error check, so the first error lands on a fresh one.
    expect(listThreads(db)).toHaveLength(2);
    await expect(poller.backfillJob.run(ctx)).resolves.toBe("worked");
    expect(getMeta(db, POLL_META.backfillCompletedAt)).toBeDefined();
    expect(await poller.backfillJob.run(ctx)).toBe("idle");
  });

  test("an error on a fresh iterator propagates and the next run starts over", async () => {
    const { db, gh, poller, ctx } = setup();
    gh.setThreads(fakeThread({ id: "1", updatedAt: ago(HOUR) }));
    gh.nextError = new Error("boom");
    await expect(poller.backfillJob.run(ctx)).rejects.toThrow("boom");
    expect(await poller.backfillJob.run(ctx)).toBe("worked");
    expect(listThreads(db)).toHaveLength(1);
    expect(callsOf(gh, "listNotificationsBefore")).toBe(2);
  });

  test("the cutoff stays fixed to the first start", async () => {
    const { gh, poller, ctx, advance } = setup({ polling: { backfillDays: 30 } });
    gh.nextError = new Error("boom");
    await expect(poller.backfillJob.run(ctx)).rejects.toThrow();
    advance(DAY);
    await poller.backfillJob.run(ctx);
    const cutoffs = gh.calls.flatMap((c) => (c.method === "listNotificationsBefore" ? [c.cutoff] : []));
    expect(cutoffs).toEqual([new Date(START.getTime() - 30 * DAY), new Date(START.getTime() - 30 * DAY)]);
  });
});

describe("scheduler errors", () => {
  test("a token error stops the worker and records auth_failed", async () => {
    const { db, gh, scheduler } = setup();
    gh.nextError = new TokenError("bad token");
    expect(await scheduler.tick()).toBe("stopped");
    expect(getMeta(db, WORKER_STATUS_KEY)).toBe("auth_failed");
    expect(scheduler.isStopped).toBe(true);
  });

  test("a plain 403 on notifications stops the worker", async () => {
    const { db, gh, scheduler } = setup();
    gh.nextError = new GitHubApiError("forbidden", 403);
    expect(await scheduler.tick()).toBe("stopped");
    expect(getMeta(db, WORKER_STATUS_KEY)).toBe("auth_failed");
  });

  test("a rate limit pauses every job for at least a minute", async () => {
    const { gh, ctx, scheduler, advance } = setup();
    gh.nextError = new RateLimitedError("slow down", null, true);
    expect(await scheduler.tick()).toBe("paused");
    expect(ctx.governor.pausedUntil()).toEqual(new Date(START.getTime() + 60_000));
    advance(30_000);
    expect(await scheduler.tick()).toBe("paused");
    advance(30_000);
    expect(await scheduler.tick()).toBe("worked");
  });

  test("other errors back off per job while later jobs keep running", async () => {
    const { gh, scheduler, advance } = setup();
    gh.nextError = new Error("500");
    expect(await scheduler.tick()).toBe("worked");
    expect(scheduler.failingJobs()).toEqual(new Map([["notifications", 1]]));
    expect(callsOf(gh, "listNotificationsBefore")).toBe(1);
    advance(5_000);
    await scheduler.tick();
    expect(scheduler.failingJobs().size).toBe(0);
  });

  test("overlapping ticks share one run", async () => {
    const { gh, scheduler } = setup();
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(a).toBe(b);
    expect(callsOf(gh, "pollNotifications")).toBe(1);
  });
});
