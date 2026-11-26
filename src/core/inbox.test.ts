import { describe, expect, test } from "bun:test";
import {
  buildInboxPayload,
  buildSubjectDetail,
  closedByAuthorLines,
  entryKey,
  hiddenActivityLine,
  hiddenActivitySince,
  isDoneQuiet,
} from "./inbox.ts";
import type { InboxRow, Section, SubjectView } from "./pipeline/types.ts";
import type { ThreadRecord } from "./types.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");

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

function view(key: string, url: string | null): SubjectView {
  return {
    key,
    header: {
      key,
      repo: "acme/app",
      number: null,
      kind: "other",
      title: "v1.0",
      url,
      author: null,
      authorIsBot: false,
      state: null,
      draft: false,
      merged: false,
      headRef: null,
      baseRef: null,
      ciState: null,
      reviewDecision: null,
      latestHumanActor: null,
      labels: [],
      enrichError: null,
    },
    rounds: [],
    lastVisitAt: null,
    body: null,
    links: [],
    section: "updates",
    reasons: [],
    score: 0,
    newMeaningfulCount: 0,
    summaryLine: "",
    hiddenStats: { pushes: 0, merged: 0, closed: 0 },
    sortAt: "2026-11-01T00:00:00Z",
    snoozeUntil: null,
    unread: false,
  };
}

function thread(reason: string, subjectUrl: string | null): ThreadRecord {
  return {
    threadId: "1",
    subjectKey: "acme/app@1",
    repo: "acme/app",
    subjectType: "Release",
    reason,
    unread: true,
    updatedAt: "2026-11-01T00:00:00Z",
    lastReadAt: null,
    firstSeenAt: "2026-11-01T00:00:00Z",
    ghDoneAt: null,
    subjectUrl,
    raw: {},
  };
}

describe("isDoneQuiet", () => {
  const DONE = "2026-11-05T12:00:00.000Z";

  test("a Hidden row with nothing newer than the Done is quiet", () => {
    expect(isDoneQuiet(row("a#1", "hidden", { sortAt: "2026-11-05T12:00:00Z" }), DONE)).toBe(true);
    expect(isDoneQuiet(row("a#1", "hidden", { sortAt: "2026-11-01T00:00:00Z" }), DONE)).toBe(true);
  });

  test("activity after the Done brings the row back", () => {
    expect(isDoneQuiet(row("a#1", "hidden", { sortAt: "2026-11-05T12:00:01Z" }), DONE)).toBe(false);
  });

  test("a row never marked Done, or listed outside Hidden, is not quiet", () => {
    expect(isDoneQuiet(row("a#1", "hidden", { sortAt: "2026-11-01T00:00:00Z" }), null)).toBe(false);
    expect(isDoneQuiet(row("a#1", "waiting", { sortAt: "2026-11-01T00:00:00Z" }), DONE)).toBe(false);
  });
});

describe("buildInboxPayload", () => {
  const rows = [
    row("acme/app#1", "hidden", { hiddenStats: { pushes: 2, merged: 1, closed: 0 } }),
    row("acme/app#2", "updates", { sortAt: "2026-11-03T00:00:00Z" }),
    row("acme/lib#3", "waiting", { repo: "acme/lib", sortAt: "2026-11-02T00:00:00Z" }),
    row("acme/app#4", "waiting", { sortAt: "2026-11-05T00:00:00Z" }),
    row("acme/app#5", "snoozed"),
    row("acme/lib#6", "hidden", { repo: "acme/lib", hiddenStats: { pushes: 0, merged: 0, closed: 1 } }),
    row("acme/app#7", "waiting", { sortAt: "2026-11-02T00:00:00Z" }),
  ];

  test("sorts by section order, then newest first, and leaves hidden rows out", () => {
    const payload = buildInboxPayload(rows, { includeHidden: false, now: NOW });
    expect(payload.rows.map(entryKey)).toEqual([
      "acme/app#4",
      "acme/app#7",
      "acme/lib#3",
      "acme/app#2",
      "acme/app#5",
    ]);
    expect(payload.generatedAt).toBe(NOW.toISOString());
  });

  test("lists hidden rows last when asked", () => {
    const payload = buildInboxPayload(rows, { includeHidden: true, now: NOW });
    expect(payload.rows.slice(-2).map(entryKey)).toEqual(["acme/app#1", "acme/lib#6"]);
  });

  test("counts every section and the active rows per repo", () => {
    const { sidebar } = buildInboxPayload(rows, { includeHidden: false, now: NOW });
    expect(sidebar.sections).toEqual({ waiting: 3, updates: 1, snoozed: 1, hidden: 2 });
    expect(sidebar.repos).toEqual([
      { repo: "acme/app", waiting: 2, updates: 1 },
      { repo: "acme/lib", waiting: 1, updates: 0 },
    ]);
  });

  test("counts hidden PRs closed by their authors per repo, busiest first", () => {
    const closed = { hiddenStats: { pushes: 0, merged: 0, closed: 1 }, reasons: ["closedByAuthor" as const] };
    const { closedByAuthor } = buildInboxPayload(
      [
        row("acme/app#1", "hidden", { hiddenStats: { pushes: 2, merged: 0, closed: 0 } }),
        row("acme/app#2", "hidden", closed),
        row("acme/lib#3", "hidden", { ...closed, repo: "acme/lib" }),
        row("acme/lib#4", "hidden", { ...closed, repo: "acme/lib" }),
      ],
      { includeHidden: false, now: NOW },
    );
    expect(closedByAuthor).toEqual([
      { repo: "acme/lib", count: 2 },
      { repo: "acme/app", count: 1 },
    ]);
  });
});

describe("hiddenActivitySince", () => {
  const SINCE = "2026-11-10T00:00:00Z";
  const stats = (pushes: number, merged = 0, closed = 0) => ({ hiddenStats: { pushes, merged, closed } });
  const rows = [
    row("acme/app#1", "hidden", { ...stats(3, 1), sortAt: "2026-11-11T00:00:00Z" }),
    row("acme/app#2", "hidden", { ...stats(5), sortAt: "2026-11-09T00:00:00Z" }),
    row("acme/lib#3", "hidden", { ...stats(2, 0, 1), repo: "acme/lib", sortAt: "2026-11-12T00:00:00Z" }),
    row("acme/lib#4", "hidden", {
      ...stats(0, 0, 1),
      repo: "acme/lib",
      reasons: ["closedByAuthor"],
      sortAt: "2026-11-12T00:00:00Z",
    }),
    row("acme/app#5", "waiting", { ...stats(7), sortAt: "2026-11-12T00:00:00Z" }),
  ];

  test("sums hidden rows with activity after the given time", () => {
    expect(hiddenActivitySince(rows, SINCE, null)).toEqual({ items: 2, pushes: 5, merged: 1, closed: 1 });
  });

  test("keeps to the selected repo", () => {
    expect(hiddenActivitySince(rows, SINCE, "acme/app")).toEqual({ items: 1, pushes: 3, merged: 1, closed: 0 });
  });

  test("reads as one line", () => {
    expect(hiddenActivityLine(hiddenActivitySince(rows, SINCE, null))).toBe(
      "Since you last looked: 5 pushes, 1 merged, 1 closed across 2 hidden items",
    );
    expect(hiddenActivityLine({ items: 1, pushes: 1, merged: 0, closed: 0 })).toBe(
      "Since you last looked: 1 push across 1 hidden item",
    );
    expect(hiddenActivityLine({ items: 2, pushes: 0, merged: 0, closed: 0 })).toBe(
      "Since you last looked: activity on 2 hidden items",
    );
    expect(hiddenActivityLine({ items: 0, pushes: 0, merged: 0, closed: 0 })).toBe(
      "Nothing new in Hidden since you last looked",
    );
  });
});

describe("closedByAuthorLines", () => {
  test("shows one line per repo, only for the selected repo when there is one", () => {
    const counts = [
      { repo: "acme/lib", count: 2 },
      { repo: "acme/app", count: 1 },
    ];
    expect(closedByAuthorLines(counts, null)).toEqual(["lib: 2 closed by author", "app: 1 closed by author"]);
    expect(closedByAuthorLines(counts, "acme/app")).toEqual(["app: 1 closed by author"]);
  });

  test("caps the lines", () => {
    const counts = Array.from({ length: 7 }, (_, i) => ({ repo: `acme/r${i}`, count: 1 }));
    const lines = closedByAuthorLines(counts, null);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("and 2 more repos");
  });
});

describe("buildSubjectDetail", () => {
  test("uses the newest thread's reason and the header URL", () => {
    const detail = buildSubjectDetail(view("acme/app#1", "https://github.com/acme/app/pull/1"), [
      thread("review_requested", null),
      thread("subscribed", null),
    ]);
    expect(detail.reason).toBe("review_requested");
    expect(detail.githubUrl).toBe("https://github.com/acme/app/pull/1");
  });

  test("has no reason or URL without threads or a header URL", () => {
    const detail = buildSubjectDetail(view("acme/app#1", null), []);
    expect(detail.reason).toBeNull();
    expect(detail.githubUrl).toBeNull();
  });

  test.each([
    ["https://api.github.com/repos/acme/app/discussions/12", "https://github.com/acme/app/discussions/12"],
    ["https://api.github.com/repos/acme/app/releases/123", "https://github.com/acme/app/releases"],
    ["https://api.github.com/repos/acme/app/commits/abc123", "https://github.com/acme/app/commit/abc123"],
    ["https://api.github.com/repos/acme/app/check-suites/9", "https://github.com/acme/app"],
    ["https://example.com/elsewhere", null],
  ])("maps the notification URL %s", (subjectUrl, expected) => {
    const detail = buildSubjectDetail(view("acme/app@1", null), [thread("subscribed", subjectUrl)]);
    expect(detail.githubUrl).toBe(expected);
  });
});
