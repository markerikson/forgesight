import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ThreadUpsert } from "../core/types.ts";
import { DEFAULT_ITEM_STATE, getItemState, putItemState } from "./item-state.ts";
import {
  applyStateOps,
  claimOutbox,
  completeOutbox,
  dueOutbox,
  failOutbox,
  OUTBOX_DELAY_MS,
  outboxSummary,
  pruneStateOps,
  retryOutbox,
  STALE_CLAIM_MS,
  undoStateOp,
} from "./state-ops.ts";
import { ensureSubjects } from "./subjects.ts";
import { memoryDb } from "./test-db.ts";
import { upsertThreads } from "./threads.ts";
import { changesAfter } from "./views.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";
const DUE = new Date(Date.parse(T0) + OUTBOX_DELAY_MS).toISOString();

function thread(id: string, subjectKey: string, unread = true): ThreadUpsert {
  return {
    threadId: id,
    subjectKey,
    repo: subjectKey.split("#")[0] ?? "",
    subjectType: "PullRequest",
    reason: "review_requested",
    unread,
    updatedAt: T0,
    lastReadAt: null,
    subjectUrl: null,
    raw: { id },
  };
}

/** acme/app#1 has threads 10 (unread) and 11 (read); acme/app#2 has none. */
function seeded(): Database {
  const db = memoryDb();
  ensureSubjects(db, [
    { subjectKey: "acme/app#1", repo: "acme/app", number: 1, kind: "pr", origin: "thread" },
    { subjectKey: "acme/app#2", repo: "acme/app", number: 2, kind: "pr", origin: "stack" },
  ]);
  upsertThreads(db, [thread("10", "acme/app#1"), thread("11", "acme/app#1", false)], T0);
  return db;
}

function outboxRows(db: Database) {
  return db
    .query<
      { op: string; thread_id: string; subject_key: string; run_after: string; cancelled_by: number | null },
      []
    >(
      "SELECT op, thread_id, subject_key, run_after, cancelled_by FROM outbox ORDER BY id",
    )
    .all();
}

describe("applyStateOps", () => {
  test("records the op, writes item state and changes, and queues writes for threads only", () => {
    const db = seeded();
    const before = changesAfter(db, 0).length;
    const result = applyStateOps(db, ["acme/app#1", "acme/app#2", "acme/app#1"], { kind: "done" }, T0);

    const op = db.query<{ op_json: string; prev_json: string }, []>("SELECT * FROM state_ops").get();
    expect(JSON.parse(op?.op_json ?? "")).toEqual({ kind: "done" });
    expect(Object.keys(JSON.parse(op?.prev_json ?? "{}"))).toEqual(["acme/app#1", "acme/app#2"]);

    expect(getItemState(db, "acme/app#1")).toEqual({ ...DEFAULT_ITEM_STATE, dismissedAt: T0, doneAt: T0, readAt: T0 });
    expect(getItemState(db, "acme/app#2").doneAt).toBe(T0);
    expect(
      changesAfter(db, 0)
        .slice(before)
        .map((c) => [c.kind, c.subjectKey]),
    ).toEqual([
      ["state", "acme/app#1"],
      ["state", "acme/app#2"],
    ]);

    expect(outboxRows(db)).toEqual([
      { op: "done", thread_id: "10", subject_key: "acme/app#1", run_after: DUE, cancelled_by: null },
      { op: "done", thread_id: "11", subject_key: "acme/app#1", run_after: DUE, cancelled_by: null },
    ]);
    expect(result.outboxIds).toHaveLength(2);
  });

  test("read queues writes for unread threads only", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "read" }, T0);
    expect(outboxRows(db).map((r) => [r.op, r.thread_id])).toEqual([["read", "10"]]);
  });

  test("repeating an op skips threads whose write is still waiting", () => {
    const db = seeded();
    const first = applyStateOps(db, ["acme/app#1"], { kind: "read" }, T0);
    expect(applyStateOps(db, ["acme/app#1"], { kind: "read" }, T1).outboxIds).toEqual([]);

    const [id] = first.outboxIds;
    if (id === undefined) throw new Error("expected an outbox row");
    completeOutbox(db, id, T1);
    expect(applyStateOps(db, ["acme/app#1"], { kind: "read" }, T2).outboxIds).toHaveLength(1);
  });

  test("an opposite write queued in between does not count as the same write waiting", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "unsubscribe" }, T0);
    for (const row of dueOutbox(db, DUE, 10)) completeOutbox(db, row.id, T1);
    const unmute = applyStateOps(db, ["acme/app#1"], { kind: "unmute" }, T1);
    claimOutbox(db, unmute.outboxIds[0] ?? 0, T1);
    const unsubscribe = applyStateOps(db, ["acme/app#1"], { kind: "unsubscribe" }, T2);
    expect(outboxRows(db).map((r) => [r.op, r.thread_id, r.cancelled_by])).toEqual([
      ["unsubscribe", "10", null],
      ["unsubscribe", "11", null],
      ["resubscribe", "10", null],
      ["resubscribe", "11", unsubscribe.opId],
      ["unsubscribe", "10", null],
      ["unsubscribe", "11", null],
    ]);
  });

  test("keep unread cancels a read still waiting, and undoing it revives the read", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "read" }, T0);
    const unread = applyStateOps(db, ["acme/app#1"], { kind: "unread" }, T1);
    expect(outboxRows(db).map((r) => [r.op, r.thread_id, r.cancelled_by])).toEqual([
      ["read", "10", unread.opId],
    ]);
    expect(dueOutbox(db, T2, 10)).toEqual([]);
    expect(outboxSummary(db).pending).toBe(0);

    expect(undoStateOp(db, unread.opId, T2)).toEqual({ kind: "undone", githubApplied: 0 });
    expect(dueOutbox(db, T2, 10).map((r) => r.op)).toEqual(["read"]);
  });

  test("read after a cancelled read queues the write again", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "read" }, T0);
    applyStateOps(db, ["acme/app#1"], { kind: "unread" }, T1);
    expect(applyStateOps(db, ["acme/app#1"], { kind: "read" }, T2).outboxIds).toHaveLength(1);
    expect(dueOutbox(db, "2026-01-02T00:00:00.000Z", 10).map((r) => r.op)).toEqual(["read"]);
  });

  test("keep unread does not cancel a read already claimed", () => {
    const db = seeded();
    const read = applyStateOps(db, ["acme/app#1"], { kind: "read" }, T0);
    claimOutbox(db, read.outboxIds[0] ?? 0, DUE);
    applyStateOps(db, ["acme/app#1"], { kind: "unread" }, T1);
    expect(outboxRows(db).map((r) => r.cancelled_by)).toEqual([null]);
  });

  test("unmute cancels an unsubscribe still waiting instead of queuing a resubscribe", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "unsubscribe" }, T0);
    const unmute = applyStateOps(db, ["acme/app#1"], { kind: "unmute" }, T1);
    expect(unmute.outboxIds).toEqual([]);
    expect(outboxRows(db).map((r) => [r.op, r.cancelled_by])).toEqual([
      ["unsubscribe", unmute.opId],
      ["unsubscribe", unmute.opId],
    ]);
    expect(dueOutbox(db, T2, 10)).toEqual([]);
  });

  test("mute after unmute cancels the resubscribe still waiting, and unmute queues it again", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "unsubscribe" }, T0);
    for (const row of dueOutbox(db, DUE, 10)) completeOutbox(db, row.id, T1);
    applyStateOps(db, ["acme/app#1"], { kind: "unmute" }, T1);
    const mute = applyStateOps(db, ["acme/app#1"], { kind: "mute" }, T1);
    expect(outboxRows(db).map((r) => [r.op, r.cancelled_by])).toEqual([
      ["unsubscribe", null],
      ["unsubscribe", null],
      ["resubscribe", mute.opId],
      ["resubscribe", mute.opId],
    ]);
    expect(applyStateOps(db, ["acme/app#1"], { kind: "unmute" }, T2).outboxIds).toHaveLength(2);
  });

  test("ops without a GitHub write queue nothing", () => {
    const db = seeded();
    const result = applyStateOps(
      db,
      ["acme/app#1"],
      { kind: "snooze", until: T2, untilHumanEvent: false, untilReady: false },
      T0,
    );
    expect(result.outboxIds).toEqual([]);
    expect(getItemState(db, "acme/app#1")).toMatchObject({ snoozeUntil: T2, snoozedAt: T0 });
  });

  test("unread restores dismissedAt from before the newest read", () => {
    const db = seeded();
    putItemState(db, "acme/app#1", { ...DEFAULT_ITEM_STATE, dismissedAt: T0 }, T0);
    applyStateOps(db, ["acme/app#1"], { kind: "read" }, T1);
    expect(getItemState(db, "acme/app#1").dismissedAt).toBe(T1);
    applyStateOps(db, ["acme/app#1"], { kind: "unread" }, T2);
    expect(getItemState(db, "acme/app#1")).toEqual({
      ...DEFAULT_ITEM_STATE,
      dismissedAt: T0,
      readAt: T1,
      keepUnread: true,
    });
  });

  test("unread after a later done keeps the done's dismissedAt", () => {
    const db = seeded();
    putItemState(db, "acme/app#1", { ...DEFAULT_ITEM_STATE, dismissedAt: T0 }, T0);
    applyStateOps(db, ["acme/app#1"], { kind: "read" }, T0);
    applyStateOps(db, ["acme/app#1"], { kind: "done" }, T1);
    applyStateOps(db, ["acme/app#1"], { kind: "unread" }, T2);
    expect(getItemState(db, "acme/app#1")).toMatchObject({ dismissedAt: T1, keepUnread: true });
  });

  test("unmute still resubscribes after the sent unsubscribe rows are pruned", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "unsubscribe" }, T0);
    for (const row of dueOutbox(db, DUE, 10)) completeOutbox(db, row.id, T1);
    pruneStateOps(db, T2);
    applyStateOps(db, ["acme/app#1"], { kind: "unmute" }, T2);
    expect(outboxRows(db).filter((r) => r.op === "resubscribe")).toHaveLength(2);
  });

  test("unmute ignores unsubscribe rows of an undone op that never went out", () => {
    const db = seeded();
    const { opId, outboxIds } = applyStateOps(db, ["acme/app#1"], { kind: "unsubscribe" }, T0);
    claimOutbox(db, outboxIds[0] ?? 0, DUE);
    undoStateOp(db, opId, T1);
    applyStateOps(db, ["acme/app#1"], { kind: "mute" }, T1);
    applyStateOps(db, ["acme/app#1"], { kind: "unmute" }, T2);
    expect(outboxRows(db).filter((r) => r.op === "resubscribe")).toEqual([]);
  });

  test("unmute resubscribes only the threads an unsubscribe reached", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "unsubscribe" }, T0);
    const [first, second] = dueOutbox(db, DUE, 10);
    if (!first || !second) throw new Error("expected two outbox rows");
    completeOutbox(db, first.id, T1);
    failOutbox(db, second.id, "boom", T1);
    applyStateOps(db, ["acme/app#1"], { kind: "unmute" }, T1);
    expect(outboxRows(db).map((r) => [r.op, r.thread_id])).toEqual([
      ["unsubscribe", "10"],
      ["unsubscribe", "11"],
      ["resubscribe", "10"],
    ]);
  });
});

describe("undoStateOp", () => {
  test("before the drainer claims, deletes the outbox rows and restores state", () => {
    const db = seeded();
    const { opId } = applyStateOps(db, ["acme/app#1", "acme/app#2"], { kind: "done" }, T0);
    expect(undoStateOp(db, opId, T1)).toEqual({ kind: "undone", githubApplied: 0 });
    expect(outboxRows(db)).toEqual([]);
    expect(getItemState(db, "acme/app#1")).toEqual(DEFAULT_ITEM_STATE);
    expect(getItemState(db, "acme/app#2")).toEqual(DEFAULT_ITEM_STATE);
    expect(undoStateOp(db, opId, T1)).toEqual({ kind: "alreadyUndone" });
  });

  test("after a claim, reports the writes that already went to GitHub", () => {
    const db = seeded();
    const { opId, outboxIds } = applyStateOps(db, ["acme/app#1"], { kind: "done" }, T0);
    const [claimed = 0, unclaimed = 0] = outboxIds;
    expect(claimOutbox(db, claimed, DUE)).toBe(true);
    expect(undoStateOp(db, opId, T1)).toEqual({ kind: "undone", githubApplied: 1 });
    expect(getItemState(db, "acme/app#1")).toEqual(DEFAULT_ITEM_STATE);
    expect(claimOutbox(db, unclaimed, DUE)).toBe(false);
  });

  test("a claimed row of an undone op is never due or claimable again", () => {
    const db = seeded();
    const { opId, outboxIds } = applyStateOps(db, ["acme/app#1"], { kind: "done" }, T0);
    const [claimed = 0] = outboxIds;
    claimOutbox(db, claimed, DUE);
    undoStateOp(db, opId, T1);
    const stale = new Date(Date.parse(DUE) + STALE_CLAIM_MS).toISOString();
    expect(dueOutbox(db, stale, 10)).toEqual([]);
    expect(claimOutbox(db, claimed, stale)).toBe(false);
    expect(outboxSummary(db).pending).toBe(0);
  });

  test("refuses when a newer op touched one of the keys", () => {
    const db = seeded();
    const first = applyStateOps(db, ["acme/app#1", "acme/app#2"], { kind: "read" }, T0);
    const second = applyStateOps(db, ["acme/app#2"], { kind: "mute" }, T1);
    expect(undoStateOp(db, first.opId, T2)).toEqual({ kind: "superseded" });
    expect(undoStateOp(db, second.opId, T2)).toEqual({ kind: "undone", githubApplied: 0 });
    expect(undoStateOp(db, first.opId, T2)).toEqual({ kind: "undone", githubApplied: 0 });
  });

  test("reports an unknown op", () => {
    expect(undoStateOp(seeded(), 99, T0)).toEqual({ kind: "notFound" });
  });
});

describe("outbox drain", () => {
  test("rows are due after the undo delay, and a claimed row is not due again until stale", () => {
    const db = seeded();
    const { outboxIds } = applyStateOps(db, ["acme/app#1"], { kind: "done" }, T0);
    expect(dueOutbox(db, T0, 10)).toEqual([]);
    expect(dueOutbox(db, DUE, 10).map((r) => r.id)).toEqual(outboxIds);

    const [id = 0] = outboxIds;
    expect(claimOutbox(db, id, DUE)).toBe(true);
    expect(claimOutbox(db, id, DUE)).toBe(false);
    expect(dueOutbox(db, DUE, 10).map((r) => r.id)).not.toContain(id);
    const stale = new Date(Date.parse(DUE) + STALE_CLAIM_MS).toISOString();
    expect(dueOutbox(db, stale, 10).map((r) => r.id)).toContain(id);
  });

  test("retry, fail, and complete update the summary", () => {
    const db = seeded();
    const { outboxIds } = applyStateOps(db, ["acme/app#1"], { kind: "done" }, T0);
    const [a = 0, b = 0] = outboxIds;
    expect(outboxSummary(db)).toEqual({ pending: 2, failed: 0, lastError: null });

    claimOutbox(db, a, DUE);
    retryOutbox(db, a, "502", T2);
    expect(dueOutbox(db, T1, 10).map((r) => r.id)).toEqual([b]);
    expect(dueOutbox(db, T2, 10).find((r) => r.id === a)).toMatchObject({ attempts: 1, claimedAt: null });

    failOutbox(db, b, "422 gone", T1);
    expect(outboxSummary(db)).toEqual({ pending: 1, failed: 1, lastError: "422 gone" });

    completeOutbox(db, a, T2, "not_found");
    expect(outboxSummary(db)).toEqual({ pending: 0, failed: 1, lastError: "422 gone" });
    expect(claimOutbox(db, a, T2)).toBe(false);
  });

  test("prune drops completed rows and ops with nothing left, keeping failed rows", () => {
    const db = seeded();
    const done = applyStateOps(db, ["acme/app#1"], { kind: "done" }, T0);
    applyStateOps(db, ["acme/app#2"], { kind: "read" }, T0);
    const [a = 0, b = 0] = done.outboxIds;
    completeOutbox(db, a, T1);
    failOutbox(db, b, "boom", T1);

    expect(pruneStateOps(db, T2)).toEqual({ outbox: 1, stateOps: 1 });
    expect(outboxRows(db).map((r) => r.thread_id)).toEqual(["11"]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM state_ops").get()?.n).toBe(1);
  });

  test("prune keeps an undone op that a sent row still names as its canceller", () => {
    const db = seeded();
    applyStateOps(db, ["acme/app#1"], { kind: "unsubscribe" }, T0);
    const unmute = applyStateOps(db, ["acme/app#1"], { kind: "unmute" }, T0);
    undoStateOp(db, unmute.opId, T0);
    for (const row of dueOutbox(db, DUE, 10)) completeOutbox(db, row.id, T1);

    expect(() => pruneStateOps(db, "2026-02-01T00:00:00.000Z")).not.toThrow();
    expect(outboxRows(db).map((r) => r.cancelled_by)).toEqual([unmute.opId, unmute.opId]);
  });
});
