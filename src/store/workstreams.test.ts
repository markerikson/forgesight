import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Workstream } from "../core/workstreams.ts";
import { getPrText, getPrTexts, putPrTexts, stalePrTexts } from "./pr-texts.ts";
import { undoStateOp } from "./state-ops.ts";
import { ensureSubjects } from "./subjects.ts";
import { memoryDb } from "./test-db.ts";
import { upsertThreads } from "./threads.ts";
import { changesAfter } from "./views.ts";
import { applyWorkstreamOps } from "./workstream-ops.ts";
import {
  getWorkstream,
  getWorkstreamState,
  listOverrides,
  listWorkstreams,
  memberFacts,
  previousWorkstreams,
  setManualName,
  stackContextsFor,
  workstreamIdsFor,
  writeWorkstreams,
} from "./workstreams.ts";

const T0 = "2026-11-24T10:00:00.000Z";
const T1 = "2026-11-24T11:00:00.000Z";
const T2 = "2026-11-24T12:00:00.000Z";
const REPO = "octo/stack";
const k = (n: number) => `${REPO}#${n}`;
const ID = `${REPO}:ws:10`;

function ws(members: number[], name = "Root PR", id = ID, closedAt: string | null = null): Workstream {
  const keys = members.map(k);
  return {
    id,
    repo: REPO,
    name,
    nameSource: "title",
    members: keys,
    edges: keys.slice(1).map((child, i) => ({ child, parent: keys[i] as string })),
    signals: ["stack"],
    author: "alice",
    prefix: null,
    closed: closedAt !== null,
    closedAt,
  };
}

function changes(db: Database, kind: string): (string | null)[] {
  return changesAfter(db, 0)
    .filter((c) => c.kind === kind)
    .map((c) => c.subjectKey);
}

describe("writeWorkstreams", () => {
  test("stores members in order with parents and appends stack and workstream changes", () => {
    const db = memoryDb();
    const res = writeWorkstreams(db, REPO, [ws([10, 11])], new Set([k(11)]), T0);
    expect(res).toEqual({ changedKeys: [k(10), k(11)], changedIds: [ID] });

    const stored = getWorkstream(db, ID);
    expect(stored?.members).toEqual([
      { key: k(10), position: 0, parent: null, listingOnly: false },
      { key: k(11), position: 1, parent: k(10), listingOnly: true },
    ]);
    expect(stored?.firstSeenAt).toBe(T0);
    expect(changes(db, "stack")).toEqual([k(10), k(11)]);
    expect(changes(db, "workstream")).toEqual([ID]);
    expect(workstreamIdsFor(db, [k(11), k(99)])).toEqual(new Map([[k(11), ID]]));
    expect(stackContextsFor(db, [k(11)]).get(k(11))).toMatchObject({ workstreamId: ID, parent: k(10) });
  });

  test("an unchanged rewrite appends nothing; a grown one keeps first_seen_at and the manual name", () => {
    const db = memoryDb();
    writeWorkstreams(db, REPO, [ws([10, 11])], new Set(), T0);
    setManualName(db, ID, "My stack", T0);
    const seq = changesAfter(db, 0).length;

    expect(writeWorkstreams(db, REPO, [ws([10, 11])], new Set(), T1)).toEqual({
      changedKeys: [],
      changedIds: [],
    });
    expect(changesAfter(db, 0)).toHaveLength(seq);

    const res = writeWorkstreams(db, REPO, [ws([10, 11, 12], "Renamed root")], new Set(), T2);
    expect(res.changedIds).toEqual([ID]);
    expect(res.changedKeys.toSorted()).toEqual([k(10), k(11), k(12)]);
    const stored = getWorkstream(db, ID);
    expect(stored).toMatchObject({
      name: "My stack",
      detectedName: "Renamed root",
      manualName: "My stack",
      firstSeenAt: T0,
      updatedAt: T2,
    });
  });

  test("deletes vanished workstreams but keeps their state", () => {
    const db = memoryDb();
    writeWorkstreams(db, REPO, [ws([10, 11])], new Set(), T0);
    applyWorkstreamOps(db, ID, { kind: "setPriority", priority: "low" }, T0);
    const res = writeWorkstreams(db, REPO, [], new Set(), T1);
    expect(res).toEqual({ changedKeys: [k(10), k(11)], changedIds: [ID] });
    expect(getWorkstream(db, ID)).toBeUndefined();
    expect(getWorkstreamState(db, ID).priority).toBe("low");
    expect(previousWorkstreams(db, REPO)).toEqual([]);
  });

  test("keeps a vanished closed workstream archived for 14 days for reopen matching", () => {
    const db = memoryDb();
    writeWorkstreams(db, REPO, [ws([10, 11], "Root PR", ID, T0)], new Set(), T0);
    writeWorkstreams(db, REPO, [], new Set(), T1);
    expect(getWorkstream(db, ID)).toBeUndefined();
    expect(listWorkstreams(db, REPO)).toEqual([]);
    expect(previousWorkstreams(db, REPO)).toEqual([
      expect.objectContaining({ id: ID, closed: true, closedAt: T0, author: "alice", members: [] }),
    ]);

    writeWorkstreams(db, REPO, [ws([30, 31], "Root PR", ID)], new Set(), T2);
    expect(getWorkstream(db, ID)).toMatchObject({ firstSeenAt: T0, closed: false });

    writeWorkstreams(db, REPO, [ws([30, 31], "Root PR", ID, T2)], new Set(), T2);
    writeWorkstreams(db, REPO, [], new Set(), "2026-12-09T12:00:00.000Z");
    expect(previousWorkstreams(db, REPO)).toEqual([]);
  });
});

describe("memberFacts", () => {
  test("collects author, open review requests, reviewers, commenters and thread section", () => {
    const db = memoryDb();
    ensureSubjects(db, [
      { subjectKey: k(10), repo: REPO, number: 10, kind: "pr", origin: "stack" },
      { subjectKey: k(11), repo: REPO, number: 11, kind: "pr", origin: "thread" },
    ]);
    db.query("UPDATE subjects SET author = 'alice' WHERE subject_key = ?").run(k(10));
    const item = db.query(
      `INSERT INTO timeline_items (node_id, subject_key, typename, created_at, raw_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    item.run("n1", k(10), "ReviewRequestedEvent", T0, JSON.stringify({ requestedReviewer: { login: "mark" } }), T0);
    item.run("n2", k(10), "ReviewRequestedEvent", T0, JSON.stringify({ requestedReviewer: { login: "bob" } }), T0);
    item.run("n3", k(10), "ReviewRequestRemovedEvent", T1, JSON.stringify({ requestedReviewer: { login: "bob" } }), T0);
    item.run("n4", k(10), "PullRequestReview", T1, JSON.stringify({ author: { login: "carol" } }), T0);
    item.run("n5", k(10), "IssueComment", T2, JSON.stringify({ author: { login: "dave" } }), T0);
    upsertThreads(
      db,
      [
        {
          threadId: "T1",
          subjectKey: k(11),
          repo: REPO,
          subjectType: "PullRequest",
          reason: "subscribed",
          unread: true,
          updatedAt: T0,
          lastReadAt: null,
          subjectUrl: null,
          raw: {},
        },
      ],
      T0,
    );

    const facts = memberFacts(db, [k(10), k(11), k(12)]);
    expect(facts.get(k(10))).toEqual({
      author: "alice",
      requestedReviewers: ["mark"],
      reviewers: ["carol"],
      commenters: ["dave"],
      threadSection: null,
    });
    expect(facts.get(k(11))?.threadSection).toBe("updates");
    expect(facts.has(k(12))).toBe(false);
  });
});

describe("workstream ops", () => {
  function setup(): Database {
    const db = memoryDb();
    writeWorkstreams(db, REPO, [ws([10, 11]), ws([20, 21], "Other", `${REPO}:ws:20`)], new Set(), T0);
    return db;
  }

  test("setPriority and seen update state; undo restores it", () => {
    const db = setup();
    const { opId } = applyWorkstreamOps(db, ID, { kind: "setPriority", priority: "muted" }, T1);
    expect(getWorkstreamState(db, ID)).toMatchObject({ priority: "muted", seenAt: T1 });
    expect(undoStateOp(db, opId, T2)).toEqual({ kind: "undone", githubApplied: 0 });
    expect(getWorkstreamState(db, ID)).toMatchObject({ priority: "normal", seenAt: null });

    applyWorkstreamOps(db, ID, { kind: "seen", summaryHash: "abc" }, T1);
    expect(getWorkstreamState(db, ID)).toMatchObject({ seenAt: T1, seenSummaryHash: "abc" });
  });

  test("snooze stores the wake conditions", () => {
    const db = setup();
    applyWorkstreamOps(db, ID, { kind: "snooze", until: T2, untilHumanEvent: true, untilReady: false }, T1);
    expect(getWorkstreamState(db, ID)).toMatchObject({
      snoozeUntil: T2,
      snoozeUntilHumanEvent: true,
      snoozeUntilReady: false,
      snoozedAt: T1,
    });
    applyWorkstreamOps(db, ID, { kind: "unsnooze" }, T2);
    expect(getWorkstreamState(db, ID).snoozeUntil).toBeNull();
  });

  test("rename sets the manual name without an override; undo restores it", () => {
    const db = setup();
    const { opId } = applyWorkstreamOps(db, ID, { kind: "rename", name: "Auth rework" }, T1);
    expect(getWorkstream(db, ID)).toMatchObject({ name: "Auth rework", nameSource: "manual" });
    expect(listOverrides(db, REPO)).toEqual([]);
    undoStateOp(db, opId, T2);
    expect(getWorkstream(db, ID)).toMatchObject({ name: "Root PR", manualName: null, nameSource: "title" });
  });

  test("merge and remove write overrides that undo deletes", () => {
    const db = setup();
    const merge = applyWorkstreamOps(db, ID, { kind: "merge", from: `${REPO}:ws:20` }, T1);
    const remove = applyWorkstreamOps(db, ID, { kind: "remove", key: k(11) }, T1);
    expect(listOverrides(db, REPO).map((o) => o.override)).toEqual([
      { kind: "merge", keys: [k(11), k(21)] },
      { kind: "remove", key: k(11) },
    ]);
    expect(undoStateOp(db, merge.opId, T2)).toEqual({ kind: "superseded" });
    undoStateOp(db, remove.opId, T2);
    undoStateOp(db, merge.opId, T2);
    expect(listOverrides(db, REPO)).toEqual([]);
  });

  test("a later op on the same workstream supersedes an earlier one", () => {
    const db = setup();
    const first = applyWorkstreamOps(db, ID, { kind: "setPriority", priority: "low" }, T1);
    applyWorkstreamOps(db, `${REPO}:ws:20`, { kind: "setPriority", priority: "low" }, T1);
    applyWorkstreamOps(db, ID, { kind: "seen", summaryHash: null }, T1);
    expect(undoStateOp(db, first.opId, T2)).toEqual({ kind: "superseded" });
  });

  test("throws for an unknown workstream", () => {
    expect(() => applyWorkstreamOps(setup(), "nope", { kind: "unsnooze" }, T1)).toThrow();
  });
});

describe("pr texts", () => {
  test("put, get and list stale", () => {
    const db = memoryDb();
    putPrTexts(db, [
      { repo: REPO, number: 1, title: "One", body: "b1", updatedAt: T0, fetchedAt: T0 },
      { repo: REPO, number: 2, title: "Two", body: "b2", updatedAt: T1, fetchedAt: T1 },
    ]);
    expect(getPrText(db, REPO, 1)?.title).toBe("One");
    expect(getPrText(db, REPO, 3)).toBeUndefined();
    expect([...getPrTexts(db, REPO, [1, 2, 3]).keys()].sort()).toEqual([1, 2]);
    expect(
      stalePrTexts(db, REPO, [
        { number: 1, updatedAt: T1 },
        { number: 2, updatedAt: T1 },
        { number: 3, updatedAt: T0 },
      ]),
    ).toEqual([1, 3]);
  });
});
