import { describe, expect, test } from "bun:test";
import { type HiddenReasonInput, hiddenReason, quietActivity } from "./hidden.ts";
import type { EventData, EventKind, Level, QuietActivity, ViewEvent } from "./types.ts";

let seq = 0;
function ev(kind: EventKind, opts: { level?: Level; isNew?: boolean; bot?: boolean; data?: Omit<EventData, "typename"> } = {}): ViewEvent {
  seq++;
  return {
    id: `E${seq}`,
    at: "2026-11-21T00:00:00Z",
    actor: { login: opts.bot ? "renovate" : "bob", isBot: opts.bot ?? false },
    kind,
    data: { typename: "Test", ...opts.data },
    level: opts.level ?? "collapsed",
    isNew: opts.isNew ?? true,
  };
}

const NONE: QuietActivity = { bots: 0, pushes: 0, rebases: 0, labels: 0, other: 0 };

function hidden(overrides: Partial<HiddenReasonInput> = {}): HiddenReasonInput {
  return {
    section: "hidden",
    reasons: ["nothingNew"],
    merged: false,
    quiet: NONE,
    ...overrides,
  };
}

describe("quietActivity", () => {
  test("counts new events the view does not show, by kind", () => {
    const quiet = quietActivity([
      ev("commit"),
      ev("forcePush"),
      ev("forcePush", { data: { verdict: "rebase_only" } }),
      ev("labeled"),
      ev("milestoned"),
      ev("comment", { bot: true }),
      ev("renamed"),
    ]);
    expect(quiet).toEqual({ bots: 1, pushes: 2, rebases: 1, labels: 2, other: 1 });
  });

  test("ignores shown and old events", () => {
    expect(quietActivity([ev("comment", { level: "show" }), ev("commit", { isNew: false })])).toEqual(NONE);
  });

  test("counts hidden-level events too", () => {
    expect(quietActivity([ev("comment", { bot: true, level: "hidden" })]).bots).toBe(1);
  });
});

describe("hiddenReason", () => {
  test("is null outside Hidden", () => {
    expect(hiddenReason(hidden({ section: "updates" }))).toBeNull();
    expect(hiddenReason(hidden({ section: "snoozed", reasons: ["snoozed"] }))).toBeNull();
  });

  test("muted wins over every other reason", () => {
    expect(hiddenReason(hidden({ reasons: ["closedByAuthor", "muted"] }))).toBe("muted");
  });

  test("closed by its author", () => {
    expect(hiddenReason(hidden({ reasons: ["closedByAuthor"] }))).toBe("closed by its author without merging");
  });

  test("merged or closed by others with no new comments, whether or not the merge is new", () => {
    expect(hiddenReason(hidden({ reasons: ["closedByOthers"], merged: true }))).toBe("merged, no new comments");
    expect(hiddenReason(hidden({ reasons: ["closedByOthers"], merged: false }))).toBe("closed, no new comments");
  });

  test("a followed announcement discussion", () => {
    expect(hiddenReason(hidden({ reasons: ["announcement"] }))).toBe("announcement you only follow");
  });

  test("issues I only follow: comments, and closes as not planned", () => {
    expect(hiddenReason(hidden({ reasons: ["subscribedOnly"] }))).toBe("new comments on an issue you only follow");
    expect(hiddenReason(hidden({ reasons: ["closedUnplanned"] }))).toBe("closed as not planned or duplicate");
  });

  test("names the only kinds of quiet activity", () => {
    expect(hiddenReason(hidden({ quiet: { ...NONE, bots: 3 } }))).toBe("only bot activity");
    expect(hiddenReason(hidden({ quiet: { ...NONE, labels: 1 } }))).toBe("only label changes");
    expect(hiddenReason(hidden({ quiet: { ...NONE, pushes: 2, rebases: 1 } }))).toBe("only pushes and rebases");
    expect(hiddenReason(hidden({ quiet: { ...NONE, bots: 1, pushes: 1, labels: 1 } }))).toBe(
      "only bot activity, pushes and label changes",
    );
  });

  test("nothing new when there is no quiet activity or the view predates it", () => {
    expect(hiddenReason(hidden())).toBe("nothing new since your last visit");
    const { quiet: _, ...old } = hidden();
    expect(hiddenReason(old)).toBe("nothing new since your last visit");
  });
});
