import { describe, expect, test } from "bun:test";
import { buildInboxPayload } from "./inbox.ts";
import type { InboxRow, Section } from "./pipeline/types.ts";
import {
  applyStateOp,
  isValidStateOp,
  type OutboxThread,
  outboxOpFor,
  outboxThreads,
  patchInbox,
  patchRow,
  type StateOp,
} from "./state.ts";
import type { ItemState } from "./types.ts";

const NOW = "2026-11-24T12:00:00.000Z";
const EARLIER = "2026-11-20T08:00:00.000Z";
const LATER = "2026-11-25T09:00:00.000Z";

const BASE: ItemState = {
  dismissedAt: null,
  doneAt: null,
  keepUnread: false,
  snoozeUntil: null,
  snoozeUntilHumanEvent: false,
  snoozeUntilReady: false,
  snoozedAt: null,
  muted: false,
};

const SNOOZED: ItemState = {
  ...BASE,
  snoozeUntil: LATER,
  snoozeUntilHumanEvent: true,
  snoozeUntilReady: true,
  snoozedAt: EARLIER,
};

const SNOOZE: StateOp = { kind: "snooze", until: LATER, untilHumanEvent: true, untilReady: false };

function row(key: string, section: Section, overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    key,
    repo: "acme/app",
    number: 1,
    kind: "pr",
    title: key,
    url: null,
    author: null,
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

describe("applyStateOp", () => {
  test("done dismisses, records doneAt, and clears snooze and keepUnread", () => {
    const next = applyStateOp({ ...SNOOZED, keepUnread: true }, { kind: "done" }, NOW);
    expect(next).toEqual({ ...BASE, dismissedAt: NOW, doneAt: NOW });
  });

  test("read dismisses and clears keepUnread", () => {
    const next = applyStateOp({ ...SNOOZED, keepUnread: true }, { kind: "read" }, NOW);
    expect(next).toEqual({ ...SNOOZED, dismissedAt: NOW });
  });

  test("unread sets keepUnread and restores dismissedAt from before the read", () => {
    const read = { ...BASE, dismissedAt: NOW };
    expect(applyStateOp(read, { kind: "unread" }, NOW, { dismissedBeforeRead: EARLIER })).toEqual({
      ...BASE,
      dismissedAt: EARLIER,
      keepUnread: true,
    });
    expect(applyStateOp(read, { kind: "unread" }, NOW, { dismissedBeforeRead: null })).toEqual({
      ...BASE,
      keepUnread: true,
    });
  });

  test("unread keeps dismissedAt when there was no read", () => {
    const next = applyStateOp({ ...BASE, dismissedAt: EARLIER }, { kind: "unread" }, NOW);
    expect(next).toEqual({ ...BASE, dismissedAt: EARLIER, keepUnread: true });
  });

  test("snooze records the wake conditions and when it started", () => {
    expect(applyStateOp(BASE, SNOOZE, NOW)).toEqual({
      ...BASE,
      snoozeUntil: LATER,
      snoozeUntilHumanEvent: true,
      snoozeUntilReady: false,
      snoozedAt: NOW,
    });
  });

  test("unsnooze clears every snooze field", () => {
    expect(applyStateOp(SNOOZED, { kind: "unsnooze" }, NOW)).toEqual(BASE);
  });

  test.each(["mute", "unsubscribe"] as const)("%s mutes", (kind) => {
    expect(applyStateOp(BASE, { kind }, NOW)).toEqual({ ...BASE, muted: true });
  });

  test("unmute unmutes", () => {
    expect(applyStateOp({ ...BASE, muted: true }, { kind: "unmute" }, NOW)).toEqual(BASE);
  });
});

describe("outboxOpFor", () => {
  test.each([
    ["done", "done"],
    ["read", "read"],
    ["unsubscribe", "unsubscribe"],
    ["unread", null],
    ["unsnooze", null],
    ["mute", null],
  ] as const)("%s queues %s", (kind, expected) => {
    expect(outboxOpFor({ kind }, BASE)).toBe(expected);
  });

  test("snooze queues nothing", () => {
    expect(outboxOpFor(SNOOZE, BASE)).toBeNull();
  });

  test("unmute resubscribes only a muted item", () => {
    expect(outboxOpFor({ kind: "unmute" }, { ...BASE, muted: true })).toBe("resubscribe");
    expect(outboxOpFor({ kind: "unmute" }, BASE)).toBeNull();
  });
});

describe("outboxThreads", () => {
  const threads: OutboxThread[] = [
    { threadId: "1", unread: true, ghDoneAt: null, unsubscribed: false },
    { threadId: "2", unread: false, ghDoneAt: null, unsubscribed: true },
    { threadId: "3", unread: true, ghDoneAt: EARLIER, unsubscribed: false },
  ];

  test("read targets unread threads only", () => {
    expect(outboxThreads("read", threads)).toEqual(["1", "3"]);
  });

  test("done skips threads already done on GitHub", () => {
    expect(outboxThreads("done", threads)).toEqual(["1", "2"]);
  });

  test("unsubscribe targets every thread", () => {
    expect(outboxThreads("unsubscribe", threads)).toEqual(["1", "2", "3"]);
  });

  test("resubscribe targets unsubscribed threads only", () => {
    expect(outboxThreads("resubscribe", threads)).toEqual(["2"]);
  });
});

describe("patchRow", () => {
  const waiting = row("acme/app#1", "waiting", { unread: true, newMeaningfulCount: 3 });

  test("done removes the row, or moves it to hidden when hidden rows are listed", () => {
    expect(patchRow(waiting, { kind: "done" }, NOW)).toBeNull();
    expect(patchRow(waiting, { kind: "done" }, NOW, { includeHidden: true })?.section).toBe("hidden");
  });

  test.each(["mute", "unsubscribe"] as const)("%s hides a plain row", (kind) => {
    expect(patchRow(waiting, { kind }, NOW)).toBeNull();
    expect(patchRow(waiting, { kind }, NOW, { includeHidden: true })?.section).toBe("hidden");
  });

  test.each(["reviewRequested", "mentioned"] as const)("mute keeps a %s row in its section", (reason) => {
    const direct = row("acme/app#1", "waiting", { reasons: [reason] });
    expect(patchRow(direct, { kind: "mute" }, NOW)).toEqual(direct);
  });

  test("snooze moves the row to snoozed", () => {
    expect(patchRow(waiting, SNOOZE, NOW)).toEqual({ ...waiting, section: "snoozed", snoozeUntil: LATER });
  });

  test("read clears unread and the new-event count", () => {
    expect(patchRow(waiting, { kind: "read" }, NOW)).toEqual({ ...waiting, unread: false, newMeaningfulCount: 0 });
  });

  test("unread marks the row unread", () => {
    const read = row("acme/app#1", "updates");
    expect(patchRow(read, { kind: "unread" }, NOW)).toEqual({ ...read, unread: true });
  });

  test.each(["unsnooze", "unmute"] as const)("%s leaves the row for the server to place", (kind) => {
    const snoozed = row("acme/app#1", "snoozed", { snoozeUntil: LATER });
    expect(patchRow(snoozed, { kind }, NOW)).toEqual(snoozed);
  });
});

describe("patchInbox", () => {
  const rows = [
    row("acme/app#1", "waiting", { sortAt: "2026-11-05T00:00:00Z" }),
    row("acme/app#2", "waiting", { sortAt: "2026-11-04T00:00:00Z" }),
    row("acme/lib#3", "updates", { repo: "acme/lib", sortAt: "2026-11-03T00:00:00Z" }),
    row("acme/app#4", "updates", { sortAt: "2026-11-02T00:00:00Z" }),
    row("acme/app#5", "hidden"),
  ];

  test("done drops the rows and moves them into the hidden count", () => {
    const payload = buildInboxPayload(rows, { includeHidden: false, now: new Date(NOW) });
    const next = patchInbox(payload, ["acme/app#1", "acme/lib#3"], { kind: "done" }, NOW);
    expect(next.rows.map((r) => r.key)).toEqual(["acme/app#2", "acme/app#4"]);
    expect(next.sidebar.sections).toEqual({ waiting: 1, updates: 1, snoozed: 0, hidden: 3 });
    expect(next.sidebar.repos).toEqual([{ repo: "acme/app", waiting: 1, updates: 1 }]);
    expect(next.countLines).toBe(payload.countLines);
  });

  test("keeps done rows as hidden when the list shows hidden rows", () => {
    const payload = buildInboxPayload(rows, { includeHidden: true, now: new Date(NOW) });
    const next = patchInbox(payload, ["acme/app#1"], { kind: "done" }, NOW);
    expect(next.rows.map((r) => r.key)).toEqual(["acme/app#2", "acme/lib#3", "acme/app#4", "acme/app#1", "acme/app#5"]);
    expect(next.sidebar.sections).toEqual({ waiting: 1, updates: 2, snoozed: 0, hidden: 2 });
  });

  test("snooze re-sorts the row into the snoozed section", () => {
    const payload = buildInboxPayload(rows, { includeHidden: false, now: new Date(NOW) });
    const next = patchInbox(payload, ["acme/app#1"], SNOOZE, NOW);
    expect(next.rows.map((r) => [r.key, r.section])).toEqual([
      ["acme/app#2", "waiting"],
      ["acme/lib#3", "updates"],
      ["acme/app#4", "updates"],
      ["acme/app#1", "snoozed"],
    ]);
    expect(next.sidebar.sections).toEqual({ waiting: 1, updates: 2, snoozed: 1, hidden: 1 });
  });

  test("leaves rows outside the keys untouched", () => {
    const payload = buildInboxPayload(rows, { includeHidden: false, now: new Date(NOW) });
    const next = patchInbox(payload, ["acme/app#9"], { kind: "read" }, NOW);
    expect(next.rows).toEqual(payload.rows);
    expect(next.sidebar).toEqual(payload.sidebar);
  });
});

describe("isValidStateOp", () => {
  test.each([
    { kind: "done" },
    { kind: "unsubscribe" },
    { kind: "snooze", until: LATER, untilHumanEvent: false, untilReady: false },
    { kind: "snooze", until: null, untilHumanEvent: true, untilReady: false },
    { kind: "snooze", until: null, untilHumanEvent: false, untilReady: true },
  ])("accepts %j", (op) => {
    expect(isValidStateOp(op)).toBe(true);
  });

  test.each([
    [null],
    ["done"],
    [[]],
    [{ kind: "archive" }],
    [{ kind: "done", extra: 1 }],
    [{ kind: "snooze", until: null, untilHumanEvent: false, untilReady: false }],
    [{ kind: "snooze", until: "not a date", untilHumanEvent: false, untilReady: false }],
    [{ kind: "snooze", until: LATER, untilHumanEvent: "yes", untilReady: false }],
    [{ kind: "snooze", until: LATER, untilHumanEvent: false }],
  ])("rejects %j", (op: unknown) => {
    expect(isValidStateOp(op)).toBe(false);
  });
});
