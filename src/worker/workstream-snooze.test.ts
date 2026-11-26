import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import type { EnrichmentResult } from "../core/types.ts";
import { DEFAULT_WORKSTREAM_STATE, type WorkstreamState } from "../core/workstream-state.ts";
import type { Workstream } from "../core/workstreams.ts";
import { ensureSubjects, saveEnrichment } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { changesAfter } from "../store/views.ts";
import { putWorkstreamState, writeWorkstreams } from "../store/workstreams.ts";
import { deriveViews } from "./derive.ts";
import type { Logger } from "./scheduler.ts";
import { groupSnoozed, workstreamsWokenBy } from "./workstream-snooze.ts";

const REPO = "octo/repo";
const KEY = `${REPO}#1`;
const OTHER = `${REPO}#2`;
const ID = `${REPO}:ws:1`;
const ME = "markerikson";
const SNOOZED_AT = "2026-11-23T10:00:00.000Z";
const BEFORE = "2026-11-23T09:00:00Z";
const AFTER = "2026-11-23T11:00:00Z";
const NOW = new Date("2026-11-23T12:00:00Z");
const quietLog: Logger = { info() {}, warn() {}, error() {} };

interface CommentSpec {
  login: string;
  at: string;
  bot?: boolean;
}

function enrichment(key: string, number: number, comments: CommentSpec[]): EnrichmentResult {
  return {
    subjectKey: key,
    subject: {
      nodeId: `PR_${number}`,
      state: "OPEN",
      author: "alice",
      headRef: `b${number}`,
      baseRef: "main",
      headSha: "h",
      baseSha: "b",
      updatedAt: BEFORE,
      raw: { title: `PR ${number}`, author: { login: "alice", __typename: "User" } },
    },
    timelineItems: comments.map((c, i) => ({
      nodeId: `IC_${number}_${i}`,
      typename: "IssueComment",
      createdAt: c.at,
      raw: {
        __typename: "IssueComment",
        id: `IC_${number}_${i}`,
        createdAt: c.at,
        author: { login: c.login, __typename: c.bot ? "Bot" : "User" },
        body: "a comment",
      },
    })),
    stickies: [],
    timelineSyncedUntil: BEFORE,
  };
}

function workstream(): Workstream {
  return {
    id: ID,
    repo: REPO,
    name: "PR 1",
    nameSource: "title",
    members: [KEY, OTHER],
    edges: [{ child: OTHER, parent: KEY }],
    signals: ["stack"],
    author: "alice",
    prefix: null,
    closed: false,
    closedAt: null,
  };
}

const HUMAN_SNOOZE: WorkstreamState = {
  ...DEFAULT_WORKSTREAM_STATE,
  snoozeUntil: "2026-11-24T09:00:00.000Z",
  snoozeUntilHumanEvent: true,
  snoozedAt: SNOOZED_AT,
};

function setup(comments: CommentSpec[], state: WorkstreamState = HUMAN_SNOOZE) {
  const db = memoryDb();
  ensureSubjects(db, [
    { subjectKey: KEY, repo: REPO, number: 1, kind: "pr", origin: "thread" },
    { subjectKey: OTHER, repo: REPO, number: 2, kind: "pr", origin: "thread" },
  ]);
  saveEnrichment(db, enrichment(KEY, 1, comments), BEFORE);
  saveEnrichment(db, enrichment(OTHER, 2, []), BEFORE);
  writeWorkstreams(db, REPO, [workstream()], new Set(), BEFORE);
  putWorkstreamState(db, ID, state, SNOOZED_AT);
  return { db, config: resolveConfig({ me: ME }) };
}

describe("groupSnoozed", () => {
  test("a member's human comment after the snooze wakes the group", () => {
    const { db, config } = setup([{ login: "bob", at: AFTER }]);
    expect(groupSnoozed(db, config, HUMAN_SNOOZE, [KEY, OTHER], NOW)).toBe(false);
  });

  test("bot comments, my own comments and earlier comments do not wake it", () => {
    for (const comment of [
      { login: "ci-bot", at: AFTER, bot: true },
      { login: ME, at: AFTER },
      { login: "bob", at: BEFORE },
    ]) {
      const { db, config } = setup([comment]);
      expect(groupSnoozed(db, config, HUMAN_SNOOZE, [KEY, OTHER], NOW)).toBe(true);
    }
  });

  test("a time-only snooze ignores member activity and ends at its time", () => {
    const timeOnly = { ...HUMAN_SNOOZE, snoozeUntilHumanEvent: false };
    const { db, config } = setup([{ login: "bob", at: AFTER }], timeOnly);
    expect(groupSnoozed(db, config, timeOnly, [KEY, OTHER], NOW)).toBe(true);
    expect(groupSnoozed(db, config, timeOnly, [KEY, OTHER], new Date("2026-11-24T10:00:00Z"))).toBe(false);
  });

  test("a listing-only member with no stored subject does not wake it", () => {
    const { db, config } = setup([]);
    expect(groupSnoozed(db, config, HUMAN_SNOOZE, [KEY, `${REPO}#99`], NOW)).toBe(true);
  });
});

describe("workstreamsWokenBy", () => {
  test("names the workstream of a member whose activity ended its snooze", () => {
    const { db, config } = setup([{ login: "bob", at: AFTER }]);
    expect(workstreamsWokenBy(db, config, [OTHER], NOW)).toEqual([ID]);
    expect(workstreamsWokenBy(db, config, [`${REPO}#99`], NOW)).toEqual([]);
  });

  test("derive announces the woken workstream so the inbox regroups", () => {
    const { db, config } = setup([{ login: "bob", at: AFTER }]);
    const announced = () => changesAfter(db, 0).filter((c) => c.kind === "workstream" && c.subjectKey === ID).length;
    const before = announced();
    deriveViews(db, config, NOW, quietLog);
    expect(announced()).toBe(before + 1);
    deriveViews(db, config, new Date("2026-11-23T12:01:00Z"), quietLog);
    expect(announced()).toBe(before + 1);
  });
});
