import { describe, expect, test } from "bun:test";
import { buildInboxPayload, buildSubjectDetail } from "./inbox.ts";
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
    expect(payload.rows.map((r) => r.key)).toEqual([
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
    expect(payload.rows.slice(-2).map((r) => r.key)).toEqual(["acme/app#1", "acme/lib#6"]);
  });

  test("counts every section and the active rows per repo", () => {
    const { sidebar } = buildInboxPayload(rows, { includeHidden: false, now: NOW });
    expect(sidebar.sections).toEqual({ waiting: 3, updates: 1, snoozed: 1, hidden: 2 });
    expect(sidebar.repos).toEqual([
      { repo: "acme/app", waiting: 2, updates: 1 },
      { repo: "acme/lib", waiting: 1, updates: 0 },
    ]);
  });

  test("summarizes hidden activity per repo, busiest first", () => {
    const { countLines } = buildInboxPayload(rows, { includeHidden: false, now: NOW });
    expect(countLines).toEqual(["app: 2 pushed, 1 merged", "lib: 1 closed"]);
  });

  test("skips hidden repos with nothing to count", () => {
    const { countLines } = buildInboxPayload([row("acme/app#1", "hidden")], { includeHidden: false, now: NOW });
    expect(countLines).toEqual([]);
  });

  test("shows the five busiest repos and counts the rest", () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      row(`acme/r${n}#1`, "hidden", { repo: `acme/r${n}`, hiddenStats: { pushes: n, merged: 0, closed: 0 } }),
    );
    const { countLines } = buildInboxPayload(many, { includeHidden: false, now: NOW });
    expect(countLines).toEqual([
      "r7: 7 pushed",
      "r6: 6 pushed",
      "r5: 5 pushed",
      "r4: 4 pushed",
      "r3: 3 pushed",
      "and 2 more repos",
    ]);
  });

  test("adds one closed-by-author line per repo after the hidden activity lines", () => {
    const closed = { hiddenStats: { pushes: 0, merged: 0, closed: 1 }, reasons: ["closedByAuthor" as const] };
    const { countLines } = buildInboxPayload(
      [
        row("acme/app#1", "hidden", { hiddenStats: { pushes: 2, merged: 0, closed: 0 } }),
        row("acme/app#2", "hidden", closed),
        row("acme/lib#3", "hidden", { ...closed, repo: "acme/lib" }),
        row("acme/lib#4", "hidden", { ...closed, repo: "acme/lib" }),
      ],
      { includeHidden: false, now: NOW },
    );
    expect(countLines).toEqual(["app: 2 pushed", "lib: 2 closed by author", "app: 1 closed by author"]);
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
