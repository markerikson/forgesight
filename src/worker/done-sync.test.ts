import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import { META } from "../core/meta-keys.ts";
import { Governor, MemoryApiCallLog } from "../github/budget.ts";
import { FakeGitHubClient, fakeThread } from "../github/fake.ts";
import { getItemState } from "../store/item-state.ts";
import { getMeta } from "../store/meta.ts";
import { memoryDb } from "../store/test-db.ts";
import { listThreads } from "../store/threads.ts";
import { doneSyncJob } from "./done-sync.ts";
import { createPoller } from "./poller.ts";
import { type JobContext, type Logger, Scheduler } from "./scheduler.ts";
import { applyStateOps } from "../store/state-ops.ts";

const START = new Date("2026-11-23T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const quietLog: Logger = { info() {}, warn() {}, error() {} };

function ago(ms: number): string {
  return new Date(START.getTime() - ms).toISOString();
}

async function setup(...threads: ReturnType<typeof fakeThread>[]) {
  let now = START;
  const clock = () => now;
  const db = memoryDb();
  const config = resolveConfig({});
  const gh = new FakeGitHubClient(clock);
  const governor = new Governor(new MemoryApiCallLog(), config.budget, clock);
  const ctx: JobContext = { db, gh, governor, config, clock, log: quietLog };
  const poller = createPoller();
  gh.setThreads(...threads);
  await new Scheduler(ctx, [poller.pollJob, poller.backfillJob], { sleep: async () => {} }).drain();
  gh.calls.length = 0;
  const thread = (id: string) => listThreads(db).find((t) => t.threadId === id);
  const subjectOf = (id: string) => thread(id)?.subjectKey ?? "";
  return {
    db,
    gh,
    ctx,
    subjectOf,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    listings: () =>
      gh.calls.flatMap((c) => (c.method === "listNotificationsByDone" ? [c.done ? "done" : "notDone"] : [])),
    ghDoneAt: (id: string) => thread(id)?.ghDoneAt ?? null,
    count: (table: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0,
  };
}

describe("doneSyncJob", () => {
  test("marks a thread done on GitHub as done here, without an outbox write", async () => {
    const t = await setup(fakeThread({ id: "1", updatedAt: ago(HOUR) }), fakeThread({ id: "2", updatedAt: ago(2 * HOUR) }));
    t.gh.done.add("1");

    expect(await doneSyncJob.run(t.ctx)).toBe("worked");

    expect(t.listings()).toEqual(["notDone", "done"]);
    expect(t.ghDoneAt("1")).toBe(START.toISOString());
    expect(t.ghDoneAt("2")).toBeNull();
    expect(getItemState(t.db, t.subjectOf("1")).doneAt).toBe(START.toISOString());
    expect(getItemState(t.db, t.subjectOf("2")).doneAt).toBeNull();
    expect(t.count("outbox")).toBe(0);
    expect(t.count("state_ops")).toBe(0);
    expect(getMeta(t.db, META.doneSyncAt)).toBe(START.toISOString());
  });

  test("runs every doneSyncMinutes and skips the done listing when nothing is missing", async () => {
    const t = await setup(fakeThread({ id: "1", updatedAt: ago(HOUR) }));

    expect(await doneSyncJob.run(t.ctx)).toBe("worked");
    expect(t.listings()).toEqual(["notDone"]);
    t.advance(10 * MINUTE);
    expect(await doneSyncJob.run(t.ctx)).toBe("idle");
    expect(t.listings()).toEqual(["notDone"]);
    t.advance(5 * MINUTE);
    expect(await doneSyncJob.run(t.ctx)).toBe("worked");
    expect(t.listings()).toEqual(["notDone", "notDone"]);
  });

  test("makes no calls when every thread is already done here", async () => {
    const t = await setup(fakeThread({ id: "1", updatedAt: ago(HOUR) }));
    applyStateOps(t.db, [t.subjectOf("1")], { kind: "done" }, START.toISOString());

    expect(await doneSyncJob.run(t.ctx)).toBe("idle");
    expect(t.gh.calls).toEqual([]);
  });

  test("does not mark a thread whose GitHub copy has newer activity", async () => {
    const t = await setup(fakeThread({ id: "1", updatedAt: ago(HOUR) }));
    t.gh.setThreads(fakeThread({ id: "1", updatedAt: ago(MINUTE) }));
    t.gh.done.add("1");

    await doneSyncJob.run(t.ctx);

    expect(t.ghDoneAt("1")).toBeNull();
    expect(getItemState(t.db, t.subjectOf("1")).doneAt).toBeNull();
  });

  test("a thread missing from both listings is left alone and rechecked a day later", async () => {
    const t = await setup(fakeThread({ id: "1", updatedAt: ago(HOUR) }), fakeThread({ id: "2", updatedAt: ago(2 * HOUR) }));
    t.gh.threads.delete("1");

    await doneSyncJob.run(t.ctx);
    expect(t.listings()).toEqual(["notDone", "done"]);
    expect(t.ghDoneAt("1")).toBeNull();

    t.advance(30 * MINUTE);
    await doneSyncJob.run(t.ctx);
    expect(t.listings()).toEqual(["notDone", "done", "notDone"]);

    t.advance(DAY);
    await doneSyncJob.run(t.ctx);
    expect(t.listings()).toEqual(["notDone", "done", "notDone", "notDone", "done"]);
  });

  test("marks the subject done only when all its threads are done on GitHub", async () => {
    const t = await setup(fakeThread({ id: "1", updatedAt: ago(HOUR) }));
    const key = t.subjectOf("1");
    t.db.query("INSERT INTO threads (thread_id, subject_key, repo, subject_type, reason, unread, updated_at, first_seen_at, subject_url, raw_json) SELECT '9', subject_key, repo, subject_type, reason, unread, updated_at, first_seen_at, subject_url, raw_json FROM threads WHERE thread_id = '1'").run();
    t.gh.done.add("1");

    await doneSyncJob.run(t.ctx);

    expect(t.ghDoneAt("1")).toBe(START.toISOString());
    expect(getItemState(t.db, key).doneAt).toBeNull();
  });
});
