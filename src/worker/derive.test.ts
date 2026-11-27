import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import { META } from "../core/meta-keys.ts";
import type { EnrichmentResult, ThreadUpsert } from "../core/types.ts";
import { DEFAULT_ITEM_STATE, getItemState, putItemState } from "../store/item-state.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { applyExternalDone } from "../store/external-done.ts";
import { applyStateOps } from "../store/state-ops.ts";
import { ensureSubjects, markDirty, saveEnrichment } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { upsertThreads } from "../store/threads.ts";
import { changesAfter, getView } from "../store/views.ts";
import { putWorkstreamState } from "../store/workstreams.ts";
import { DEFAULT_WORKSTREAM_STATE } from "../core/workstream-state.ts";
import { deriveKeys, deriveViews, rederiveAll } from "./derive.ts";
import type { Logger } from "./scheduler.ts";

const KEY = "octo/repo#1";
const quietLog: Logger = { info() {}, warn() {}, error() {} };

function enrichment(body: string, createdAt = "2026-11-23T10:00:00Z"): EnrichmentResult {
  return {
    subjectKey: KEY,
    subject: {
      nodeId: "PR_1",
      state: "OPEN",
      author: "alice",
      headRef: "b1",
      baseRef: "main",
      headSha: "h",
      baseSha: "b",
      updatedAt: "2026-11-23T10:00:00Z",
      raw: { title: "Fix it", author: { login: "alice", __typename: "User" } },
    },
    timelineItems: [
      {
        nodeId: `IC_${body.length}`,
        typename: "IssueComment",
        createdAt,
        raw: {
          __typename: "IssueComment",
          id: `IC_${body.length}`,
          createdAt,
          author: { login: "alice", __typename: "User" },
          body,
        },
      },
    ],
    stickies: [],
    timelineSyncedUntil: createdAt,
  };
}

function setup() {
  const db = memoryDb();
  ensureSubjects(db, [{ subjectKey: KEY, repo: "octo/repo", number: 1, kind: "pr", origin: "thread" }]);
  saveEnrichment(db, enrichment("@markerikson please look"), "2026-11-23T10:01:00Z");
  const config = resolveConfig({ me: "markerikson" });
  return { db, config };
}

describe("deriveViews", () => {
  test("derives new subjects, then idles until something changes", () => {
    const { db, config } = setup();
    const first = deriveViews(db, config, new Date("2026-11-23T11:00:00Z"), quietLog);
    expect(first).toMatchObject({ derived: 1, changed: 1, failed: 0 });
    expect(getView(db, KEY)?.section).toBe("waiting");
    expect(getMeta(db, META.deriveSeq)).toBeDefined();

    const second = deriveViews(db, config, new Date("2026-11-23T11:01:00Z"), quietLog);
    expect(second.derived).toBe(0);
  });

  test("re-derives after a raw change, a state change and a snooze ending", () => {
    const { db, config } = setup();
    deriveViews(db, config, new Date("2026-11-23T11:00:00Z"), quietLog);

    saveEnrichment(db, enrichment("plain update"), "2026-11-23T11:02:00Z");
    expect(deriveViews(db, config, new Date("2026-11-23T11:03:00Z"), quietLog).derived).toBe(1);

    putItemState(
      db,
      KEY,
      { ...DEFAULT_ITEM_STATE, snoozeUntil: "2026-11-23T13:00:00.000Z" },
      "2026-11-23T11:04:00Z",
    );
    expect(deriveViews(db, config, new Date("2026-11-23T11:05:00Z"), quietLog).derived).toBe(1);
    expect(getView(db, KEY)?.section).toBe("snoozed");

    expect(deriveViews(db, config, new Date("2026-11-23T12:00:00Z"), quietLog).derived).toBe(0);
    expect(deriveViews(db, config, new Date("2026-11-23T13:30:00Z"), quietLog).derived).toBe(1);
    expect(getView(db, KEY)?.section).toBe("waiting");
  });

  test("announces a workstream whose snooze ended", () => {
    const { db, config } = setup();
    deriveViews(db, config, new Date("2026-11-23T11:00:00Z"), quietLog);
    putWorkstreamState(
      db,
      "ws1",
      { ...DEFAULT_WORKSTREAM_STATE, snoozeUntil: "2026-11-23T13:00:00.000Z" },
      "2026-11-23T11:01:00Z",
    );
    const workstreamChanges = () =>
      changesAfter(db, 0).filter((c) => c.kind === "workstream" && c.subjectKey === "ws1").length;
    const before = workstreamChanges();

    deriveViews(db, config, new Date("2026-11-23T12:00:00Z"), quietLog);
    expect(workstreamChanges()).toBe(before);
    deriveViews(db, config, new Date("2026-11-23T13:30:00Z"), quietLog);
    expect(workstreamChanges()).toBe(before + 1);
    deriveViews(db, config, new Date("2026-11-23T14:00:00Z"), quietLog);
    expect(workstreamChanges()).toBe(before + 1);
  });

  test("subjects whose derivation failed are retried on the next run", () => {
    const { db, config } = setup();
    deriveViews(db, config, new Date("2026-11-23T11:00:00Z"), quietLog);
    setMeta(db, META.deriveFailed, JSON.stringify([KEY]), "2026-11-23T11:00:00Z");
    expect(deriveViews(db, config, new Date("2026-11-23T11:01:00Z"), quietLog).derived).toBe(1);
    expect(getMeta(db, META.deriveFailed)).toBe("[]");
    expect(deriveViews(db, config, new Date("2026-11-23T11:02:00Z"), quietLog).derived).toBe(0);
  });

  test("a config change re-derives every view", () => {
    const { db, config } = setup();
    deriveViews(db, config, new Date("2026-11-23T11:00:00Z"), quietLog);
    const changed = resolveConfig({ me: "markerikson", repos: { "octo/repo": { mode: "simple" } } });
    expect(deriveViews(db, changed, new Date("2026-11-23T11:01:00Z"), quietLog).derived).toBe(1);
  });
});

describe("rederiveAll", () => {
  test("rewrites views that are current by version but stale in content", () => {
    const { db, config } = setup();
    ensureSubjects(db, [{ subjectKey: "octo/repo#2", repo: "octo/repo", number: 2, kind: "pr", origin: "thread" }]);
    deriveViews(db, config, new Date("2026-11-23T11:00:00Z"), quietLog);
    db.run("UPDATE subject_views SET section = 'hidden' WHERE subject_key = ?", [KEY]);
    const seq = latestSeq(db);

    const batches: number[] = [];
    const summary = rederiveAll(db, config, new Date("2026-11-23T11:01:00Z"), quietLog, {
      batch: 1,
      onBatch: (done) => batches.push(done),
    });

    expect(summary).toMatchObject({ subjects: 2, changed: 1, failed: [] });
    expect(batches).toEqual([1, 2]);
    expect(getView(db, KEY)?.section).toBe("waiting");
    expect(changesAfter(db, seq).map((c) => c.subjectKey)).toContain(KEY);
    expect(deriveViews(db, config, new Date("2026-11-23T11:02:00Z"), quietLog).derived).toBe(0);
  });
});

function latestSeq(db: ReturnType<typeof memoryDb>): number {
  return changesAfter(db, 0).at(-1)?.seq ?? 0;
}

describe("auto done", () => {
  const DONE_AT = "2026-11-23T11:00:00.000Z";

  function thread(updatedAt: string): ThreadUpsert {
    return {
      threadId: "t1",
      subjectKey: KEY,
      repo: "octo/repo",
      subjectType: "PullRequest",
      reason: "mention",
      unread: true,
      updatedAt,
      lastReadAt: null,
      subjectUrl: null,
      raw: { id: "t1" },
    };
  }

  /** The subject was marked Done at 11:00 and its `done` write went out. */
  function doneSetup() {
    const { db, config } = setup();
    upsertThreads(db, [thread("2026-11-23T10:01:00Z")], "2026-11-23T10:01:00Z");
    applyStateOps(db, [KEY], { kind: "done" }, DONE_AT);
    db.query("UPDATE threads SET gh_done_at = ?1, unread = 0").run(DONE_AT);
    deriveKeys(db, [KEY], config, new Date("2026-11-23T11:01:00Z"), quietLog);
    return { db, config };
  }

  function doneRows(db: Database): number {
    const row = db.query("SELECT COUNT(*) AS n FROM outbox WHERE op = 'done'").get() as { n: number };
    return row.n;
  }

  function resurface(db: Database, updatedAt: string) {
    upsertThreads(db, [thread(updatedAt)], updatedAt);
  }

  test("re-marks a thread done once per new noise activity", () => {
    const { db, config } = doneSetup();
    expect(doneRows(db)).toBe(1);

    resurface(db, "2026-11-23T12:00:00Z");
    deriveKeys(db, [KEY], config, new Date("2026-11-23T12:01:00Z"), quietLog);
    expect(doneRows(db)).toBe(2);
    expect(getView(db, KEY)?.section).toBe("hidden");
    expect(getItemState(db, KEY).doneAt).toBe(DONE_AT);

    deriveKeys(db, [KEY], config, new Date("2026-11-23T12:02:00Z"), quietLog);
    expect(doneRows(db)).toBe(2);

    resurface(db, "2026-11-23T13:00:00Z");
    deriveKeys(db, [KEY], config, new Date("2026-11-23T13:01:00Z"), quietLog);
    expect(doneRows(db)).toBe(3);
  });

  test("leaves a subject alone when the new activity is meaningful", () => {
    const { db, config } = doneSetup();
    const comment = enrichment("@markerikson one more thing", "2026-11-23T12:00:00Z");
    saveEnrichment(db, comment, "2026-11-23T12:01:00Z");
    resurface(db, "2026-11-23T12:00:00Z");
    deriveKeys(db, [KEY], config, new Date("2026-11-23T12:02:00Z"), quietLog);
    expect(doneRows(db)).toBe(1);
    expect(getView(db, KEY)?.section).not.toBe("hidden");
  });

  test("waits while the subject still needs enrichment", () => {
    const { db, config } = doneSetup();
    resurface(db, "2026-11-23T12:00:00Z");
    markDirty(db, [KEY], "2026-11-23T12:00:00Z");
    deriveKeys(db, [KEY], config, new Date("2026-11-23T12:01:00Z"), quietLog);
    expect(doneRows(db)).toBe(1);
  });

  test("does not queue a thread already marked done on GitHub by another client", () => {
    const { db, config } = doneSetup();
    resurface(db, "2026-11-23T12:00:00Z");
    applyExternalDone(db, [{ threadId: "t1", subjectKey: KEY, updatedAt: "2026-11-23T12:00:00Z" }], "2026-11-23T12:00:30Z");
    deriveKeys(db, [KEY], config, new Date("2026-11-23T12:01:00Z"), quietLog);
    expect(doneRows(db)).toBe(1);
    expect(getView(db, KEY)?.section).toBe("hidden");
  });

  test("rederiveAll queues auto done too", () => {
    const { db, config } = doneSetup();
    resurface(db, "2026-11-23T12:00:00Z");
    rederiveAll(db, config, new Date("2026-11-23T12:01:00Z"), quietLog);
    expect(doneRows(db)).toBe(2);
  });
});
