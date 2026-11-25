import { describe, expect, test } from "bun:test";
import { nextRecentlyClosed } from "./recently-closed.ts";
import {
  applyWorkstreamOp,
  DEFAULT_WORKSTREAM_STATE,
  isShownWorkstream,
  isValidWorkstreamOp,
  type MemberFacts,
  workstreamSnoozeActive,
} from "./workstream-state.ts";
import type { WsPull } from "./workstreams.ts";

const T0 = "2026-11-24T10:00:00.000Z";
const T1 = "2026-11-24T11:00:00.000Z";

function facts(over: Partial<MemberFacts> = {}): MemberFacts {
  return { author: null, requestedReviewers: [], reviewers: [], commenters: [], threadSection: null, ...over };
}

describe("isShownWorkstream", () => {
  const ws = { members: ["o/r#1", "o/r#2"] };

  test("an unseen workstream is shown", () => {
    expect(isShownWorkstream(ws, new Map(), "mark", null)).toBe(true);
  });

  test("a seen workstream is shown only when Mark is involved in a member", () => {
    expect(isShownWorkstream(ws, new Map([["o/r#1", facts({ author: "alice" })]]), "mark", T0)).toBe(false);
    for (const f of [
      facts({ author: "Mark" }),
      facts({ requestedReviewers: ["mark"] }),
      facts({ reviewers: ["mark"] }),
      facts({ commenters: ["mark"] }),
      facts({ threadSection: "updates" }),
    ]) {
      expect(isShownWorkstream(ws, new Map([["o/r#2", f]]), "mark", T0)).toBe(true);
    }
    expect(isShownWorkstream(ws, new Map([["o/r#2", facts({ threadSection: "hidden" })]]), "mark", T0)).toBe(
      false,
    );
  });
});

describe("applyWorkstreamOp", () => {
  test("setPriority marks the workstream seen", () => {
    expect(applyWorkstreamOp(DEFAULT_WORKSTREAM_STATE, { kind: "setPriority", priority: "low" }, T0)).toMatchObject({
      priority: "low",
      seenAt: T0,
    });
  });

  test("seen keeps the first seenAt and the previous hash when none is given", () => {
    const seen = applyWorkstreamOp(DEFAULT_WORKSTREAM_STATE, { kind: "seen", summaryHash: "h1" }, T0);
    expect(applyWorkstreamOp(seen, { kind: "seen", summaryHash: null }, T1)).toMatchObject({
      seenAt: T0,
      seenSummaryHash: "h1",
    });
  });
});

describe("isValidWorkstreamOp", () => {
  test.each([
    [{ kind: "setPriority", priority: "muted" }, true],
    [{ kind: "setPriority", priority: "urgent" }, false],
    [{ kind: "snooze", until: T0, untilHumanEvent: false, untilReady: false }, true],
    [{ kind: "snooze", until: null, untilHumanEvent: false, untilReady: false }, false],
    [{ kind: "unsnooze" }, true],
    [{ kind: "rename", name: "Auth" }, true],
    [{ kind: "rename", name: null }, true],
    [{ kind: "rename", name: "  " }, false],
    [{ kind: "merge", from: "o/r:ws:1" }, true],
    [{ kind: "remove", key: "o/r#1" }, true],
    [{ kind: "remove" }, false],
    [{ kind: "seen", summaryHash: null }, true],
    [{ kind: "done" }, false],
  ])("%j → %p", (op, valid) => {
    expect(isValidWorkstreamOp(op)).toBe(valid);
  });
});

describe("workstreamSnoozeActive", () => {
  const snoozed = { ...DEFAULT_WORKSTREAM_STATE, snoozeUntil: T1, snoozedAt: T0 };

  test("holds until the snooze time", () => {
    expect(workstreamSnoozeActive(snoozed, [[], []], "mark", new Date(T0))).toBe(true);
    expect(workstreamSnoozeActive(snoozed, [[], []], "mark", new Date("2026-11-24T12:00:00Z"))).toBe(false);
    expect(workstreamSnoozeActive(DEFAULT_WORKSTREAM_STATE, [], "mark", new Date(T0))).toBe(false);
  });
});

describe("nextRecentlyClosed", () => {
  const pull = (number: number): WsPull => ({
    repo: "o/r",
    number,
    title: `PR ${number}`,
    author: "alice",
    headRef: `b${number}`,
    baseRef: "main",
    isDraft: false,
    updatedAt: T0,
  });
  const now = new Date(T1);

  test("adds PRs that left the listing, marking merged ones from their subject state", () => {
    const out = nextRecentlyClosed([pull(1), pull(2), pull(3)], [pull(3)], [], (n) => (n === 1 ? "MERGED" : null), now);
    expect(out.map((c) => [c.pull.number, c.pull.closed, c.closedAt])).toEqual([
      [1, "merged", T1],
      [2, "closed", T1],
    ]);
  });

  test("drops reopened PRs and entries older than 7 days", () => {
    const prior = [
      { pull: { ...pull(1), closed: "closed" as const }, closedAt: T0 },
      { pull: { ...pull(2), closed: "closed" as const }, closedAt: "2026-11-10T00:00:00.000Z" },
      { pull: { ...pull(3), closed: "closed" as const }, closedAt: T0 },
    ];
    const out = nextRecentlyClosed([], [pull(3)], prior, () => null, now);
    expect(out.map((c) => c.pull.number)).toEqual([1]);
    expect(out[0]?.closedAt).toBe(T0);
  });
});
