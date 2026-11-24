import { describe, expect, test } from "bun:test";
import type { EnrichmentResult, SubjectViewRecord, ThreadUpsert } from "../core/types.ts";
import { pruneApiCalls, recordApiCall, spendSince } from "./api-calls.ts";
import { getItemState, getItemStates, initDismissedAt, putItemState } from "./item-state.ts";
import {
  ensureSubjects,
  getSubject,
  markDirty,
  MAX_ENRICH_ATTEMPTS,
  nextDirtyBatch,
  recordEnrichError,
  saveEnrichment,
} from "./subjects.ts";
import { memoryDb } from "./test-db.ts";
import { listThreads, threadsForSubject, upsertThreads } from "./threads.ts";
import { reviewThreadsFor, stickiesFor, stickyNodeIds, timelineFor } from "./timeline.ts";
import {
  appendChange,
  changesAfter,
  countViews,
  getView,
  listViews,
  pruneChanges,
  putViews,
  staleViewKeys,
} from "./views.ts";

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-01T01:00:00Z";
const T2 = "2026-01-01T02:00:00Z";
const T3 = "2026-01-01T03:00:00Z";

function thread(id: string, subjectKey: string, updatedAt: string): ThreadUpsert {
  return {
    threadId: id,
    subjectKey,
    repo: subjectKey.split("#")[0] ?? "",
    subjectType: "PullRequest",
    reason: "review_requested",
    unread: true,
    updatedAt,
    lastReadAt: null,
    subjectUrl: null,
    raw: { id },
  };
}

function pr(subjectKey: string) {
  const [repo = "", num = "0"] = subjectKey.split("#");
  return { subjectKey, repo, number: Number(num), kind: "pr" as const, origin: "thread" as const };
}

function enrichment(subjectKey: string, extra: Partial<EnrichmentResult> = {}): EnrichmentResult {
  return {
    subjectKey,
    subject: {
      nodeId: `PR_${subjectKey}`,
      state: "OPEN",
      author: "alice",
      headRef: "feature",
      baseRef: "main",
      headSha: "abc",
      baseSha: "def",
      updatedAt: T1,
      raw: { title: "A PR" },
    },
    timelineItems: [],
    stickies: [],
    timelineSyncedUntil: null,
    ...extra,
  };
}

function view(subjectKey: string, row: Record<string, unknown>, extra: Partial<SubjectViewRecord> = {}): SubjectViewRecord {
  return {
    subjectKey,
    pipelineVersion: 1,
    configHash: "h1",
    section: "waiting",
    sortAt: T1,
    score: 1,
    repo: "o/r",
    stackId: null,
    row,
    detail: { rounds: [] },
    computedAt: T1,
    ...extra,
  };
}

describe("threads", () => {
  test("upsertThreads reports a subject only when the thread is new or updated_at moves", () => {
    const db = memoryDb();
    expect(upsertThreads(db, [thread("1", "o/r#1", T0), thread("2", "o/r#2", T0)], T0)).toEqual({
      changedSubjectKeys: ["o/r#1", "o/r#2"],
    });
    expect(upsertThreads(db, [thread("1", "o/r#1", T0), thread("2", "o/r#2", T1)], T1)).toEqual({
      changedSubjectKeys: ["o/r#2"],
    });
    expect(upsertThreads(db, [{ ...thread("1", "o/r#1", T0), unread: false }], T2)).toEqual({
      changedSubjectKeys: [],
    });

    const [t1] = threadsForSubject(db, "o/r#1");
    expect(t1?.unread).toBe(false);
    expect(t1?.firstSeenAt).toBe(T0);
    expect(t1?.raw).toEqual({ id: "1" });
    expect(listThreads(db).map((t) => t.threadId)).toEqual(["2", "1"]);
    expect(listThreads(db, { since: T1 }).map((t) => t.threadId)).toEqual(["2"]);
    expect(listThreads(db, { limit: 1 }).map((t) => t.threadId)).toEqual(["2"]);
  });
});

describe("subjects", () => {
  test("nextDirtyBatch orders by priority then age and stays within one repo", () => {
    const db = memoryDb();
    ensureSubjects(db, [pr("a/x#1"), pr("a/x#2"), pr("a/x#3"), pr("b/y#1"), pr("b/y#2")]);
    markDirty(db, ["a/x#1"], T0);
    markDirty(db, ["b/y#1"], T1, 5);
    markDirty(db, ["a/x#2"], T2, 5);
    markDirty(db, ["b/y#2"], T3);
    markDirty(db, ["a/x#3"], T3, 5);

    expect(nextDirtyBatch(db, { limit: 10 }).map((s) => s.subjectKey)).toEqual(["b/y#1", "b/y#2"]);
    expect(nextDirtyBatch(db, { limit: 2, repo: "a/x" }).map((s) => s.subjectKey)).toEqual([
      "a/x#2",
      "a/x#3",
    ]);
  });

  test("markDirty keeps the older dirty_at and the higher priority", () => {
    const db = memoryDb();
    ensureSubjects(db, [pr("o/r#1")]);
    markDirty(db, ["o/r#1"], T0, 3);
    markDirty(db, ["o/r#1"], T1, 1);
    const s = getSubject(db, "o/r#1");
    expect(s?.dirtyAt).toBe(T0);
    expect(s?.priority).toBe(3);
  });

  test("ensureSubjects leaves existing rows alone", () => {
    const db = memoryDb();
    ensureSubjects(db, [pr("o/r#1")]);
    ensureSubjects(db, [{ ...pr("o/r#1"), origin: "stack" }]);
    expect(getSubject(db, "o/r#1")?.origin).toBe("thread");
  });

  test("saveEnrichment dedupes timeline items, replaces review threads, writes one raw change", () => {
    const db = memoryDb();
    ensureSubjects(db, [pr("o/r#1")]);
    markDirty(db, ["o/r#1"], T0);
    const startSeq = appendChange(db, "status", null, T0);

    const item = (nodeId: string, createdAt: string) => ({
      nodeId,
      typename: "IssueComment",
      createdAt,
      raw: { nodeId },
    });
    const review = (nodeId: string) => ({
      nodeId,
      isResolved: false,
      isOutdated: false,
      path: "a.ts",
      line: 1,
      raw: {},
    });

    saveEnrichment(
      db,
      enrichment("o/r#1", {
        timelineItems: [item("c2", T1), item("c1", T0)],
        reviewThreads: [review("rt1"), review("rt2")],
        timelineSyncedUntil: T1,
      }),
      T1,
    );
    saveEnrichment(
      db,
      enrichment("o/r#1", {
        timelineItems: [item("c2", T1), item("c3", T2)],
        reviewThreads: [review("rt3")],
      }),
      T2,
    );

    expect(timelineFor(db, "o/r#1").map((i) => i.nodeId)).toEqual(["c1", "c2", "c3"]);
    expect(timelineFor(db, "o/r#1")[1]?.fetchedAt).toBe(T1);
    expect(reviewThreadsFor(db, "o/r#1").map((t) => t.nodeId)).toEqual(["rt3"]);

    saveEnrichment(db, enrichment("o/r#1"), T3);
    expect(reviewThreadsFor(db, "o/r#1").map((t) => t.nodeId)).toEqual(["rt3"]);

    const s = getSubject(db, "o/r#1");
    expect(s?.dirtyAt).toBeNull();
    expect(s?.timelineSyncedUntil).toBe(T1);
    expect(s?.raw).toEqual({ title: "A PR" });
    expect(changesAfter(db, startSeq)).toEqual([
      { seq: startSeq + 1, kind: "raw", subjectKey: "o/r#1" },
      { seq: startSeq + 2, kind: "raw", subjectKey: "o/r#1" },
      { seq: startSeq + 3, kind: "raw", subjectKey: "o/r#1" },
    ]);
  });

  test("saveEnrichment throws for an unknown subject and writes nothing", () => {
    const db = memoryDb();
    expect(() => saveEnrichment(db, enrichment("o/r#9"), T0)).toThrow(/unknown subject/);
    expect(changesAfter(db, 0)).toEqual([]);
  });

  test("sticky versions: same body twice is one row, an edit adds a row", () => {
    const db = memoryDb();
    ensureSubjects(db, [pr("o/r#1"), pr("o/r#2")]);
    const sticky = (body: string) => ({
      commentNodeId: "IC_1",
      author: "diffloupe[bot]",
      lastEditedAt: null,
      body,
    });

    saveEnrichment(db, enrichment("o/r#1", { stickies: [sticky("v1")] }), T0);
    saveEnrichment(db, enrichment("o/r#1", { stickies: [sticky("v1")] }), T1);
    expect(stickiesFor(db, "o/r#1").map((s) => [s.body, s.seenAt])).toEqual([["v1", T0]]);

    saveEnrichment(db, enrichment("o/r#1", { stickies: [sticky("v2")] }), T2);
    expect(stickiesFor(db, "o/r#1").map((s) => s.body)).toEqual(["v1", "v2"]);
    expect(stickyNodeIds(db, ["o/r#1", "o/r#2"])).toEqual(new Map([["o/r#1", ["IC_1"]]]));

    saveEnrichment(db, enrichment("o/r#1", { stickies: [sticky("v1")] }), T3);
    expect(stickiesFor(db, "o/r#1").map((s) => [s.body, s.seenAt, s.lastSeenAt])).toEqual([
      ["v2", T2, T2],
      ["v1", T0, T3],
    ]);
  });

  test("recordEnrichError drops the subject from the queue at the attempt limit", () => {
    const db = memoryDb();
    ensureSubjects(db, [pr("o/r#1")]);
    markDirty(db, ["o/r#1"], T0);
    for (let i = 1; i < MAX_ENRICH_ATTEMPTS; i++) recordEnrichError(db, "o/r#1", "boom", T1);
    expect(getSubject(db, "o/r#1")?.dirtyAt).toBe(T1);
    recordEnrichError(db, "o/r#1", "boom", T2);
    const s = getSubject(db, "o/r#1");
    expect(s?.dirtyAt).toBeNull();
    expect(s?.enrichAttempts).toBe(MAX_ENRICH_ATTEMPTS);
    expect(s?.enrichError).toBe("boom");
    expect(nextDirtyBatch(db, { limit: 10 })).toEqual([]);
  });

  test("markDirty keeps the attempt count of a dirty subject and resets a clean one", () => {
    const db = memoryDb();
    ensureSubjects(db, [pr("o/r#1")]);
    markDirty(db, ["o/r#1"], T0);
    recordEnrichError(db, "o/r#1", "boom", T1);
    markDirty(db, ["o/r#1"], T1);
    expect(getSubject(db, "o/r#1")?.enrichAttempts).toBe(1);

    for (let i = 1; i < MAX_ENRICH_ATTEMPTS; i++) recordEnrichError(db, "o/r#1", "boom", T2);
    expect(getSubject(db, "o/r#1")?.dirtyAt).toBeNull();
    markDirty(db, ["o/r#1"], T3);
    expect(getSubject(db, "o/r#1")).toMatchObject({ dirtyAt: T3, enrichAttempts: 0 });
  });
});

describe("item state", () => {
  test("missing rows read as the default state", () => {
    const db = memoryDb();
    expect(getItemState(db, "o/r#1")).toEqual({
      dismissedAt: null,
      keepUnread: false,
      snoozeUntil: null,
      snoozeUntilHumanEvent: false,
      muted: false,
    });
    expect(getItemStates(db, ["o/r#1"]).size).toBe(0);
  });

  test("initDismissedAt does not overwrite stored state", () => {
    const db = memoryDb();
    putItemState(
      db,
      "o/r#1",
      { ...getItemState(db, "o/r#1"), dismissedAt: T2, muted: true },
      T2,
    );
    initDismissedAt(
      db,
      [
        { key: "o/r#1", dismissedAt: T0 },
        { key: "o/r#2", dismissedAt: T0 },
      ],
      T3,
    );
    const states = getItemStates(db, ["o/r#1", "o/r#2"]);
    expect(states.get("o/r#1")).toMatchObject({ dismissedAt: T2, muted: true });
    expect(states.get("o/r#2")).toMatchObject({ dismissedAt: T0, muted: false });
    expect(changesAfter(db, 0).map((c) => [c.kind, c.subjectKey])).toEqual([["state", "o/r#1"]]);
  });
});

describe("views", () => {
  test("putViews appends a view change only when a list-visible column changes", () => {
    const db = memoryDb();
    expect(putViews(db, [view("o/r#1", { title: "a" })], T0)).toEqual(["o/r#1"]);
    expect(putViews(db, [view("o/r#1", { title: "a" }, { detail: { rounds: [1] }, score: 9 })], T1)).toEqual([]);
    expect(putViews(db, [view("o/r#1", { title: "b" })], T2)).toEqual(["o/r#1"]);
    expect(putViews(db, [view("o/r#1", { title: "b" }, { section: "hidden" })], T2)).toEqual(["o/r#1"]);
    expect(putViews(db, [view("o/r#1", { title: "b" }, { section: "hidden", sortAt: T3 })], T3)).toEqual(["o/r#1"]);
    expect(
      putViews(db, [view("o/r#1", { title: "b" }, { section: "hidden", sortAt: T3, stackId: "s1" })], T3),
    ).toEqual(["o/r#1"]);

    expect(changesAfter(db, 0).map((c) => c.kind)).toEqual(["view", "view", "view", "view", "view"]);
    expect(getView(db, "o/r#1")?.row).toEqual({ title: "b" });
  });

  test("listViews and countViews hide the hidden section unless asked", () => {
    const db = memoryDb();
    putViews(
      db,
      [
        view("o/r#1", {}, { sortAt: T1 }),
        view("o/r#2", {}, { sortAt: T2 }),
        view("o/r#3", {}, { sortAt: T3, section: "hidden" }),
      ],
      T3,
    );
    expect(listViews(db).map((v) => v.subjectKey)).toEqual(["o/r#2", "o/r#1"]);
    expect(countViews(db)).toBe(2);
    expect(listViews(db, { includeHidden: true }).map((v) => v.subjectKey)).toEqual([
      "o/r#3",
      "o/r#2",
      "o/r#1",
    ]);
  });

  test("staleViewKeys finds missing and outdated views", () => {
    const db = memoryDb();
    ensureSubjects(db, [pr("o/r#1"), pr("o/r#2"), pr("o/r#3"), pr("o/r#4")]);
    putViews(
      db,
      [
        view("o/r#1", {}),
        view("o/r#2", {}, { pipelineVersion: 0 }),
        view("o/r#3", {}, { configHash: "old" }),
      ],
      T0,
    );
    expect(staleViewKeys(db, 1, "h1")).toEqual(["o/r#2", "o/r#3", "o/r#4"]);
  });

  test("pruneChanges removes rows before the cutoff", () => {
    const db = memoryDb();
    appendChange(db, "status", null, T0);
    const kept = appendChange(db, "status", null, T2);
    expect(pruneChanges(db, T1)).toBe(1);
    expect(changesAfter(db, 0).map((c) => c.seq)).toEqual([kept]);
  });
});

describe("api calls", () => {
  test("spendSince groups by resource and work class", () => {
    const db = memoryDb();
    const call = (at: string, resource: string, workClass: string, cost: number | null) => ({
      at,
      resource,
      workClass,
      request: "GET /notifications",
      status: 200,
      cost,
      remaining: 4000,
      resetAt: null,
      durationMs: 120,
    });
    recordApiCall(db, call(T0, "core", "poll", 1));
    recordApiCall(db, call(T1, "core", "poll", 1));
    recordApiCall(db, call(T1, "graphql", "enrich", 7));
    recordApiCall(db, call(T2, "graphql", "enrich", null));

    expect(spendSince(db, T1)).toEqual([
      { resource: "core", workClass: "poll", calls: 1, cost: 1 },
      { resource: "graphql", workClass: "enrich", calls: 2, cost: 7 },
    ]);
    expect(pruneApiCalls(db, T1)).toBe(1);
    expect(spendSince(db, T0)).toHaveLength(2);
  });
});
