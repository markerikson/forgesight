import { describe, expect, test } from "bun:test";
import {
  initialDismissedAt,
  planPoll,
  planSubjects,
  type PollState,
  queuesOnFirstRun,
  type ThreadInput,
  threadChanged,
} from "./notifications.ts";

const NOW = new Date("2026-11-23T12:00:00Z");
const MIN = 60_000;

function state(overrides: Partial<PollState> = {}): PollState {
  return {
    nextPollAt: new Date(NOW.getTime() + MIN),
    lastFullAt: NOW,
    lastCheckAt: NOW,
    requestedAt: null,
    forced: false,
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<ThreadInput> = {}): ThreadInput {
  return {
    id,
    repo: "octo/repo",
    subjectType: "PullRequest",
    subjectUrl: "https://api.github.com/repos/octo/repo/pulls/7",
    reason: "subscribed",
    unread: true,
    updatedAt: "2026-11-23T10:00:00Z",
    lastReadAt: null,
    raw: {},
    ...overrides,
  };
}

describe("queuesOnFirstRun", () => {
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * MIN).toISOString();
  const issue = (days: number) => thread("i", { subjectType: "Issue", updatedAt: daysAgo(days) });

  test("queues threads from the last 14 days in any repo", () => {
    expect(queuesOnFirstRun(thread("p", { updatedAt: daysAgo(10) }), NOW, "simple")).toBe(true);
    expect(queuesOnFirstRun(thread("p", { updatedAt: daysAgo(20) }), NOW, "normal")).toBe(false);
  });

  test("queues issues from the last 30 days in normal and full repos", () => {
    expect(queuesOnFirstRun(issue(20), NOW, "normal")).toBe(true);
    expect(queuesOnFirstRun(issue(20), NOW, "full")).toBe(true);
    expect(queuesOnFirstRun(issue(20), NOW, "simple")).toBe(false);
    expect(queuesOnFirstRun(issue(35), NOW, "normal")).toBe(false);
  });
});

describe("planPoll", () => {
  test("waits for nextPollAt", () => {
    expect(planPoll(state(), NOW, 30)).toEqual({ due: false });
    expect(planPoll(state({ nextPollAt: NOW }), NOW, 30)).toEqual({
      due: true,
      full: false,
      requested: false,
    });
  });

  test("the first poll is full", () => {
    expect(planPoll(state({ nextPollAt: null, lastFullAt: null }), NOW, 30)).toMatchObject({
      due: true,
      full: true,
    });
  });

  test("full once fullRefreshMinutes have passed", () => {
    const s = state({ nextPollAt: NOW, lastFullAt: new Date(NOW.getTime() - 30 * MIN) });
    expect(planPoll(s, NOW, 30)).toMatchObject({ full: true });
  });

  test("a web request newer than the last check is due and full", () => {
    const requestedAt = new Date(NOW.getTime() + 1);
    expect(planPoll(state({ requestedAt }), NOW, 30)).toEqual({
      due: true,
      full: true,
      requested: true,
    });
    expect(planPoll(state({ requestedAt: new Date(NOW.getTime() - 1) }), NOW, 30)).toEqual({
      due: false,
    });
  });
});

describe("initialDismissedAt", () => {
  const firstRun = new Date("2026-11-23T12:00:00Z");

  test("threads older than 14 days at first run count as seen", () => {
    expect(initialDismissedAt({ updatedAt: "2026-11-01T00:00:00Z", lastReadAt: null }, firstRun)).toBe(
      "2026-11-01T00:00:00Z",
    );
  });

  test("newer threads use last_read_at, else updated_at minus 2 days", () => {
    expect(
      initialDismissedAt(
        { updatedAt: "2026-11-20T00:00:00Z", lastReadAt: "2026-11-19T00:00:00Z" },
        firstRun,
      ),
    ).toBe("2026-11-19T00:00:00Z");
    expect(initialDismissedAt({ updatedAt: "2026-11-20T00:00:00Z", lastReadAt: null }, null)).toBe(
      "2026-11-18T00:00:00.000Z",
    );
  });
});

describe("threadChanged", () => {
  test("new, moved, and read-state changes all count", () => {
    const stored = { updatedAt: "2026-11-23T10:00:00Z", unread: true, lastReadAt: null, reason: "subscribed" };
    expect(threadChanged(undefined, thread("1"))).toBe(true);
    expect(threadChanged(stored, thread("1"))).toBe(false);
    expect(threadChanged(stored, thread("1", { unread: false }))).toBe(true);
    expect(threadChanged(stored, thread("1", { reason: "mention" }))).toBe(true);
  });
});

describe("planSubjects", () => {
  test("keeps the newest thread and the highest priority per subject", () => {
    const plans = planSubjects(
      [
        thread("1", { reason: "mention", updatedAt: "2026-11-23T09:00:00Z" }),
        thread("2", { updatedAt: "2026-11-23T11:00:00Z" }),
      ],
      () => false,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.thread.id).toBe("2");
    expect(plans[0]?.priority).toBe(2);
  });
});
