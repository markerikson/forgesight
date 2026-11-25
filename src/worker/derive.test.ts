import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import { META } from "../core/meta-keys.ts";
import type { EnrichmentResult } from "../core/types.ts";
import { DEFAULT_ITEM_STATE, putItemState } from "../store/item-state.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { ensureSubjects, saveEnrichment } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { changesAfter, getView } from "../store/views.ts";
import { putWorkstreamState } from "../store/workstreams.ts";
import { DEFAULT_WORKSTREAM_STATE } from "../core/workstream-state.ts";
import { deriveViews } from "./derive.ts";
import type { Logger } from "./scheduler.ts";

const KEY = "octo/repo#1";
const quietLog: Logger = { info() {}, warn() {}, error() {} };

function enrichment(body: string): EnrichmentResult {
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
        createdAt: "2026-11-23T10:00:00Z",
        raw: {
          __typename: "IssueComment",
          id: `IC_${body.length}`,
          createdAt: "2026-11-23T10:00:00Z",
          author: { login: "alice", __typename: "User" },
          body,
        },
      },
    ],
    stickies: [],
    timelineSyncedUntil: "2026-11-23T10:00:00Z",
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
