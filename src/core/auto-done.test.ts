import { describe, expect, test } from "bun:test";
import { type AutoDoneInput, autoDoneThreads } from "./auto-done.ts";

const DONE_AT = "2026-11-23T11:00:00.000Z";

function input(over: Partial<AutoDoneInput> = {}): AutoDoneInput {
  return {
    state: { doneAt: DONE_AT, keepUnread: false },
    view: { section: "hidden", sortAt: "2026-11-23T10:00:00Z" },
    subject: { dirtyAt: null },
    threads: [{ threadId: "t1", updatedAt: "2026-11-23T12:00:00Z", ghDoneAt: null }],
    lastDoneQueuedAt: new Map(),
    ...over,
  };
}

describe("autoDoneThreads", () => {
  test("re-marks a thread GitHub brought back when the view stays quiet", () => {
    expect(autoDoneThreads(input())).toEqual(["t1"]);
  });

  test("skips subjects that are not done, kept unread or waiting for enrichment", () => {
    expect(autoDoneThreads(input({ state: { doneAt: null, keepUnread: false } }))).toEqual([]);
    expect(autoDoneThreads(input({ state: { doneAt: DONE_AT, keepUnread: true } }))).toEqual([]);
    expect(autoDoneThreads(input({ subject: { dirtyAt: "2026-11-23T12:00:00Z" } }))).toEqual([]);
  });

  test("skips a subject whose view surfaced after Done", () => {
    expect(autoDoneThreads(input({ view: { section: "waiting", sortAt: "2026-11-23T10:00:00Z" } }))).toEqual(
      [],
    );
    expect(autoDoneThreads(input({ view: { section: "hidden", sortAt: "2026-11-23T11:30:00Z" } }))).toEqual(
      [],
    );
  });

  test("only targets threads updated after Done and not already done on GitHub", () => {
    const threads = [
      { threadId: "old", updatedAt: "2026-11-23T10:30:00Z", ghDoneAt: null },
      { threadId: "sent", updatedAt: "2026-11-23T12:00:00Z", ghDoneAt: "2026-11-23T12:01:00Z" },
      { threadId: "back", updatedAt: "2026-11-23T12:00:00Z", ghDoneAt: null },
    ];
    expect(autoDoneThreads(input({ threads }))).toEqual(["back"]);
  });

  test("queues once per new activity", () => {
    const queued = new Map([["t1", "2026-11-23T12:05:00Z"]]);
    expect(autoDoneThreads(input({ lastDoneQueuedAt: queued }))).toEqual([]);
    const newer = [{ threadId: "t1", updatedAt: "2026-11-23T13:00:00Z", ghDoneAt: null }];
    expect(autoDoneThreads(input({ lastDoneQueuedAt: queued, threads: newer }))).toEqual(["t1"]);
  });
});
