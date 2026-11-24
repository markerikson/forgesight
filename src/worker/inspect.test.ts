import { describe, expect, test } from "bun:test";
import { recordApiCall } from "../store/api-calls.ts";
import { ensureSubjects, saveEnrichment } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { upsertThreads } from "../store/threads.ts";
import { budgetSummary, itemActor, itemText, recentSummary, subjectDetail } from "./inspect.ts";

const NOW = new Date("2026-11-23T12:00:00Z");
const KEY = "octo/repo#5";

function seeded() {
  const db = memoryDb();
  ensureSubjects(db, [{ subjectKey: KEY, repo: "octo/repo", number: 5, kind: "pr", origin: "thread" }]);
  upsertThreads(
    db,
    [
      {
        threadId: "T1",
        subjectKey: KEY,
        repo: "octo/repo",
        subjectType: "PullRequest",
        reason: "review_requested",
        unread: true,
        updatedAt: "2026-11-23T10:00:00Z",
        lastReadAt: null,
        subjectUrl: null,
        raw: { subject: { title: "Fix the thing" } },
      },
    ],
    NOW.toISOString(),
  );
  saveEnrichment(
    db,
    {
      subjectKey: KEY,
      subject: {
        nodeId: "PR_5",
        state: "OPEN",
        author: "alice",
        headRef: "fix",
        baseRef: "main",
        headSha: "abc",
        baseSha: "def",
        updatedAt: "2026-11-23T11:00:00Z",
        raw: { title: "Fix the thing" },
      },
      timelineItems: [
        {
          nodeId: "IC_1",
          typename: "IssueComment",
          createdAt: "2026-11-23T10:30:00Z",
          raw: { author: { login: "bob" }, body: "\nLooks good\nmore" },
        },
      ],
      reviewThreads: [],
      stickies: [],
      timelineSyncedUntil: NOW.toISOString(),
    },
    NOW.toISOString(),
  );
  return db;
}

describe("inspect", () => {
  test("recent summary lists subjects with titles and item counts", () => {
    const lines = recentSummary(seeded(), NOW);
    expect(lines[1]).toBe(`${KEY}  review_requested  Fix the thing`);
    expect(lines[2]).toContain("IssueComment 1");
  });

  test("subject detail shows columns, timeline items and sections", () => {
    const text = subjectDetail(seeded(), KEY).join("\n");
    expect(text).toContain("  headSha: abc");
    expect(text).toContain("2026-11-23T10:30:00Z  IssueComment  bob  Looks good");
    expect(text).toContain("sticky versions (0)");
    expect(subjectDetail(seeded(), "nope#1")).toEqual(["No subject nope#1"]);
  });

  test("budget summary groups spend by hour and class", () => {
    const db = memoryDb();
    for (const [at, cost] of [
      ["2026-11-23T10:05:00Z", 3],
      ["2026-11-23T10:45:00Z", 4],
    ] as const) {
      recordApiCall(db, {
        at,
        resource: "graphql",
        workClass: "enrich",
        request: "graphql octo/repo",
        status: 200,
        cost,
        remaining: null,
        resetAt: null,
        durationMs: 1,
      });
    }
    const lines = budgetSummary(db, NOW);
    expect(lines[1]).toMatch(/^2026-11-23T10 {2}graphql {3}enrich +2 +7$/);
    expect(lines.at(-1)).toContain("graphql enrich");
  });

  test("item helpers read actors and text from different item types", () => {
    expect(itemActor({ actor: { login: "carol" } })).toBe("carol");
    expect(itemActor({ commit: { author: { user: null, name: "Dan" } } })).toBe("Dan");
    expect(itemText({ commit: { messageHeadline: "Bump deps" } })).toBe("Bump deps");
    expect(itemText({ label: { name: "bug" } })).toBe("bug");
  });
});
