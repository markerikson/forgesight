import { describe, expect, test } from "bun:test";
import {
  buildInboxPayload,
  entryKey,
  type InboxGroup,
  type InboxPayload,
  isGroup,
  subjectWorkstream,
  type WorkstreamInput,
} from "./inbox.ts";
import type { InboxRow, Section } from "./pipeline/types.ts";
import { patchInbox, patchWorkstream } from "./state.ts";
import type { WorkstreamState } from "./workstream-state.ts";
import type { Workstream } from "./workstreams.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

function row(key: string, section: Section, overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    key,
    repo: "replayio/backend",
    number: Number(key.split("#")[1] ?? 1),
    kind: "pr",
    title: `Title ${key}`,
    url: null,
    author: "stacker",
    state: "OPEN",
    draft: false,
    merged: false,
    ciState: null,
    reviewDecision: null,
    latestActor: null,
    section,
    reasons: [],
    summaryLine: "",
    newMeaningfulCount: 0,
    hiddenStats: { pushes: 0, merged: 0, closed: 0 },
    sortAt: "2026-11-01T00:00:00Z",
    snoozeUntil: null,
    unread: false,
    enrichError: null,
    findings: [],
    ...overrides,
  };
}

const SEEN: WorkstreamState = {
  priority: "normal",
  seenAt: "2026-11-01T00:00:00Z",
  seenSummaryHash: "h1",
  snoozeUntil: null,
  snoozeUntilHumanEvent: false,
  snoozeUntilReady: false,
  snoozedAt: null,
};

const K1 = "replayio/backend#1";
const K2 = "replayio/backend#2";
const K3 = "replayio/backend#3";
const K4 = "replayio/backend#4";

function input(
  overrides: { state?: Partial<WorkstreamState> | null; members?: string[]; workstream?: Partial<Workstream> } = {},
): WorkstreamInput {
  const members = overrides.members ?? [K1, K2, K3, K4];
  return {
    workstream: {
      id: "ws1",
      repo: "replayio/backend",
      name: "Stack: recording uploads",
      nameSource: "title",
      members,
      edges: members.slice(1).map((child, i) => ({ child, parent: members[i]! })),
      signals: ["stack"],
      author: "stacker",
      prefix: null,
      closed: false,
      closedAt: null,
      ...overrides.workstream,
    },
    state: overrides.state === null ? null : { ...SEEN, ...overrides.state },
    summary: { name: "Upload pipeline", text: "Reworks uploads.\nSecond line.", status: null, generatedAt: NOW_ISO, inputHash: "h1" },
  };
}

const ROWS = [
  row(K1, "updates", { sortAt: "2026-11-05T00:00:00Z" }),
  row(K2, "waiting", { sortAt: "2026-11-03T00:00:00Z" }),
  row(K3, "updates", { sortAt: "2026-11-07T00:00:00Z" }),
  row(K4, "hidden", { reasons: ["closedByAuthor"], state: "CLOSED" }),
  row("acme/app#9", "updates", { repo: "acme/app", sortAt: "2026-11-06T00:00:00Z" }),
];

function build(inputs: WorkstreamInput[], includeHidden = false, rows = ROWS): InboxPayload {
  return buildInboxPayload(rows, { includeHidden, now: NOW, workstreams: inputs });
}

function groupOf(payload: InboxPayload): InboxGroup {
  const group = payload.rows.find(isGroup);
  if (!group) throw new Error("no group listed");
  return group;
}

describe("unlisted members", () => {
  const K5 = "replayio/backend#5";
  const pull = { number: 5, title: "Listing only", url: "https://github.com/replayio/backend/pull/5", state: "OPEN" as const, draft: true };

  test("hidden rows and members without a thread are unlisted, in stack order", () => {
    const ws = { ...input({ members: [K1, K5, K2, K3, K4] }), pulls: { [K5]: pull } };
    const group = groupOf(build([ws]));
    expect(group.members.map((m) => m.key)).toEqual([K1, K2, K3]);
    expect(group.unlisted).toEqual([
      { key: K5, ...pull, why: "noThread" },
      { key: K4, number: 4, title: `Title ${K4}`, url: null, state: "CLOSED", draft: false, why: "hidden" },
    ]);
    expect(group.moreCount).toBe(2);
  });

  test("a snoozed member is unlisted as snoozed", () => {
    const rows = ROWS.map((r) => (r.key === K2 ? { ...r, section: "snoozed" as const } : r));
    const group = groupOf(build([input()], false, rows));
    expect(group.unlisted.map((m) => [m.key, m.why])).toEqual([
      [K2, "snoozed"],
      [K4, "hidden"],
    ]);
  });
});

describe("buildInboxPayload with workstreams", () => {
  test("folds shown members into one row in stack order", () => {
    const payload = build([input()]);
    expect(payload.rows.map(entryKey)).toEqual(["workstream:ws1", "acme/app#9"]);
    const group = groupOf(payload);
    expect(group.members.map((m) => m.key)).toEqual([K1, K2, K3]);
    expect(group.moreCount).toBe(1);
    expect(group.section).toBe("waiting");
    expect(group.sortAt).toBe("2026-11-07T00:00:00Z");
    expect(group.name).toBe("Upload pipeline");
    expect(group.isNew).toBe(false);
  });

  test("a manual rename wins over the generated name", () => {
    expect(groupOf(build([input({ workstream: { name: "Mine", nameSource: "manual" } })])).name).toBe("Mine");
  });

  test("closed-by-author counts move into the group", () => {
    const payload = build([input()]);
    expect(groupOf(payload).closedByAuthor).toBe(1);
    expect(payload.countLines.some((line) => line.includes("closed"))).toBe(false);
  });

  test("a group counts once in the sidebar", () => {
    const payload = build([input()]);
    expect(payload.sidebar.sections).toMatchObject({ waiting: 1, updates: 1, hidden: 1 });
    expect(payload.sidebar.repos.find((r) => r.repo === "replayio/backend")).toEqual({
      repo: "replayio/backend",
      waiting: 1,
      updates: 0,
    });
  });

  test("low priority caps the group at Updates", () => {
    const group = groupOf(build([input({ state: { priority: "low" } })]));
    expect(group.section).toBe("updates");
    expect(group.priority).toBe("low");
  });

  test("a muted group goes to Hidden but a review request still shows its member", () => {
    const rows = ROWS.map((r) => (r.key === K2 ? { ...r, reasons: ["reviewRequested" as const] } : r));
    const payload = build([input({ state: { priority: "muted" } })], false, rows);
    expect(payload.rows.map(entryKey)).toEqual([K2, "acme/app#9"]);
    const withHidden = build([input({ state: { priority: "muted" } })], true, rows);
    const group = groupOf(withHidden);
    expect(group.section).toBe("hidden");
    expect(group.members.map((m) => m.key)).toEqual([K1, K3]);
  });

  test("a workstream never seen is new and sorts first in Updates", () => {
    const rows = ROWS.map((r) => (r.section === "waiting" ? row(r.key, "updates", { repo: r.repo, sortAt: r.sortAt }) : r));
    const payload = build([input({ state: null })], false, rows);
    expect(payload.rows.map(entryKey)).toEqual(["workstream:ws1", "acme/app#9"]);
    expect(groupOf(payload).isNew).toBe(true);
    expect(groupOf(payload).sortAt).toBe("2026-11-07T00:00:00Z");
  });

  test("a summary is marked changed when its hash differs from the seen one", () => {
    expect(groupOf(build([input()])).summary?.changed).toBe(false);
    expect(groupOf(build([input({ state: { seenSummaryHash: "old" } })])).summary?.changed).toBe(true);
  });

  test("a snoozed workstream sits in Snoozed", () => {
    const group = groupOf(build([input({ state: { snoozeUntil: "2026-12-01T00:00:00Z" } })]));
    expect(group.section).toBe("snoozed");
    expect(group.snoozed).toBe(true);
  });

  test("single-member workstreams stay plain rows", () => {
    expect(build([input({ members: [K1] })]).rows.every((e) => !isGroup(e))).toBe(true);
  });
});

describe("patchWorkstream", () => {
  test("muting moves the group out of the list and counts it as hidden", () => {
    const payload = build([input()]);
    const next = patchWorkstream(payload, "ws1", { kind: "setPriority", priority: "muted" }, NOW_ISO, {
      includeHidden: false,
    });
    expect(next.rows.map(entryKey)).toEqual(["acme/app#9"]);
    expect(next.sidebar.sections.hidden).toBe(payload.sidebar.sections.hidden + 1);
  });

  test("setting a priority clears the new flag", () => {
    const payload = build([input({ state: null })]);
    const next = patchWorkstream(payload, "ws1", { kind: "setPriority", priority: "low" }, NOW_ISO, {
      includeHidden: false,
    });
    const group = groupOf(next);
    expect(group.isNew).toBe(false);
    expect(group.section).toBe("updates");
  });

  test("seen clears the new flag and the changed summary", () => {
    const payload = build([input({ state: { seenAt: null, seenSummaryHash: "old" } })]);
    expect(groupOf(payload).isNew).toBe(true);
    const next = patchWorkstream(payload, "ws1", { kind: "seen", summaryHash: "h1" }, NOW_ISO, { includeHidden: false });
    expect(groupOf(next).isNew).toBe(false);
    expect(groupOf(next).summary?.changed).toBe(false);
  });

  test("snooze moves the group to Snoozed", () => {
    const payload = build([input()]);
    const op = { kind: "snooze", until: "2026-12-01T00:00:00Z", untilHumanEvent: false, untilReady: false } as const;
    const next = patchWorkstream(payload, "ws1", op, NOW_ISO, { includeHidden: false });
    expect(groupOf(next).section).toBe("snoozed");
  });

  test("rename changes the shown name", () => {
    const next = patchWorkstream(build([input()]), "ws1", { kind: "rename", name: "Uploads" }, NOW_ISO, {
      includeHidden: false,
    });
    expect(groupOf(next).name).toBe("Uploads");
  });

  test("an unknown workstream leaves the payload alone", () => {
    const payload = build([input()]);
    expect(patchWorkstream(payload, "nope", { kind: "unsnooze" }, NOW_ISO, { includeHidden: false })).toBe(payload);
  });
});

describe("patchInbox on group members", () => {
  test("done on members drops them from the group", () => {
    const payload = build([input()]);
    const next = patchInbox(payload, [K1, K3], { kind: "done" }, NOW_ISO, { includeHidden: false });
    expect(groupOf(next).members.map((m) => m.key)).toEqual([K2]);
    expect(groupOf(next).moreCount).toBe(3);
    expect(groupOf(next).unlisted.map((m) => [m.key, m.why])).toEqual([
      [K1, "hidden"],
      [K3, "hidden"],
      [K4, "hidden"],
    ]);
  });

  test("done on every shown member drops the group row", () => {
    const payload = build([input()]);
    const next = patchInbox(payload, [K1, K2, K3], { kind: "done" }, NOW_ISO, { includeHidden: false });
    expect(next.rows.map(entryKey)).toEqual(["acme/app#9"]);
  });
});

describe("subjectWorkstream", () => {
  test("gives the stack position, parent and children with titles", () => {
    const ws = subjectWorkstream(input(), K2, (k) => `Title ${k}`);
    expect(ws?.stack).toMatchObject({ parent: K1, children: [K3], position: 2, size: 4 });
    expect(ws?.titles).toEqual({ [K1]: `Title ${K1}`, [K3]: `Title ${K3}` });
    expect(ws?.name).toBe("Upload pipeline");
  });

  test("is null outside the workstream", () => {
    expect(subjectWorkstream(input(), "acme/app#9", () => null)).toBeNull();
  });
});
