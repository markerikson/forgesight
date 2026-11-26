import { describe, expect, test } from "bun:test";
import {
  branchPushes,
  deferVerdict,
  knownPushes,
  nextPending,
  queuePushes,
  saveVerdict,
  verdictCounts,
  verdictsFor,
} from "./push-verdicts.ts";
import { memoryDb } from "./test-db.ts";

const NOW = "2026-11-25T12:00:00Z";

function setup() {
  const db = memoryDb();
  const subject = (key: string, author: string) =>
    db.run(
      `INSERT INTO subjects (subject_key, repo, number, kind, origin, state, author)
       VALUES (?, 'o/r', ?, 'pr', 'thread', 'OPEN', ?)`,
      [key, Number(key.split("#")[1]), author],
    );
  const push = (id: string, key: string, at: string) =>
    db.run(
      `INSERT INTO timeline_items (node_id, subject_key, typename, created_at, raw_json, fetched_at)
       VALUES (?, ?, 'HeadRefForcePushedEvent', ?, '{}', ?)`,
      [id, key, at, at],
    );
  subject("o/r#1", "other");
  subject("o/r#2", "me");
  push("P1", "o/r#1", "2026-11-25T10:00:00Z");
  push("P2", "o/r#1", "2026-11-25T11:00:00Z");
  push("P3", "o/r#2", "2026-11-25T09:00:00Z");
  queuePushes(
    db,
    [
      { pushNodeId: "P1", subjectKey: "o/r#1", beforeSha: "a", afterSha: "b" },
      { pushNodeId: "P2", subjectKey: "o/r#1", beforeSha: "b", afterSha: "c" },
      { pushNodeId: "P3", subjectKey: "o/r#2", beforeSha: "x", afterSha: "y" },
    ],
    "api",
    NOW,
  );
  return db;
}

describe("push verdicts", () => {
  test("queueing is idempotent", () => {
    const db = setup();
    expect(queuePushes(db, [{ pushNodeId: "P1", subjectKey: "o/r#1", beforeSha: "a", afterSha: "b" }], "api", NOW)).toBe(0);
    expect(knownPushes(db, ["P1", "P9"])).toEqual(new Set(["P1"]));
    expect(verdictCounts(db)).toEqual({ pending: 3 });
  });

  test("my PRs come first, then the newest push", () => {
    const db = setup();
    expect(nextPending(db, NOW, 10, "me").map((p) => p.pushNodeId)).toEqual(["P3", "P2", "P1"]);
    expect(nextPending(db, NOW, 2, null).map((p) => p.pushNodeId)).toEqual(["P2", "P1"]);
  });

  test("saved verdicts leave the queue and show up by push node", () => {
    const db = setup();
    saveVerdict(db, "P2", { verdict: "rebase_only", reason: "patches equal", baseBefore: "master", baseAfter: "master" }, NOW);
    saveVerdict(
      db,
      "P3",
      { verdict: "noop", reason: "patches equal, same base", baseBefore: "a".repeat(40), baseAfter: "b".repeat(40) },
      NOW,
    );
    expect(nextPending(db, NOW, 10, null).map((p) => p.pushNodeId)).toEqual(["P1"]);
    expect(verdictsFor(db, "o/r#1")).toEqual(
      new Map([
        ["P1", { verdict: "pending", reason: null, onto: null }],
        ["P2", { verdict: "rebase_only", reason: "patches equal", onto: "master" }],
      ]),
    );
    expect(verdictsFor(db, "o/r#2").get("P3")?.onto).toBeNull();
  });

  test("deferred pushes wait until their next attempt", () => {
    const db = setup();
    deferVerdict(db, "P1", "2026-11-25T12:05:00Z", "HTTP 502");
    expect(nextPending(db, NOW, 10, null).map((p) => p.pushNodeId)).toEqual(["P2", "P3"]);
    const later = nextPending(db, "2026-11-25T12:05:00Z", 10, null).find((p) => p.pushNodeId === "P1");
    expect(later?.attempts).toBe(1);
  });

  test("a deferral can leave the attempt count alone", () => {
    const db = setup();
    deferVerdict(db, "P1", "2026-11-25T12:05:00Z", "network error", { countAttempt: false });
    const later = nextPending(db, "2026-11-25T12:05:00Z", 10, null).find((p) => p.pushNodeId === "P1");
    expect(later?.attempts).toBe(0);
  });
});

describe("branchPushes", () => {
  test("collects force-pushes from the PRs whose head is each branch", () => {
    const db = memoryDb();
    const subject = (key: string, repo: string, headRef: string) =>
      db.run(
        `INSERT INTO subjects (subject_key, repo, number, kind, origin, state, head_ref)
         VALUES (?, ?, ?, 'pr', 'thread', 'MERGED', ?)`,
        [key, repo, Number(key.split("#")[1]), headRef],
      );
    const push = (id: string, key: string, at: string, raw: unknown) =>
      db.run(
        `INSERT INTO timeline_items (node_id, subject_key, typename, created_at, raw_json, fetched_at)
         VALUES (?, ?, 'HeadRefForcePushedEvent', ?, ?, ?)`,
        [id, key, at, JSON.stringify(raw), at],
      );
    const shas = (before: string, after: string) => ({ beforeCommit: { oid: before }, afterCommit: { oid: after } });
    subject("o/r#1", "o/r", "parent");
    subject("o/r#2", "o/r", "other");
    subject("x/y#1", "x/y", "parent");
    push("A2", "o/r#1", "2026-11-25T11:00:00Z", shas("b", "c"));
    push("A1", "o/r#1", "2026-11-25T10:00:00Z", shas("a", "b"));
    push("A3", "o/r#1", "2026-11-25T12:00:00Z", { beforeCommit: null, afterCommit: { oid: "d" } });
    push("B1", "o/r#2", "2026-11-25T10:00:00Z", shas("m", "n"));
    push("C1", "x/y#1", "2026-11-25T10:00:00Z", shas("p", "q"));

    expect(branchPushes(db, "o/r", ["parent", "missing"])).toEqual(
      new Map([
        [
          "parent",
          [
            { at: "2026-11-25T10:00:00Z", before: "a", after: "b" },
            { at: "2026-11-25T11:00:00Z", before: "b", after: "c" },
          ],
        ],
      ]),
    );
  });
});
