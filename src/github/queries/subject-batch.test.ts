import { describe, expect, test } from "bun:test";
import { DIFFLOUPE_MARKER, queryShape, REPLAY_QA_MARKER } from "../../core/enrich-plan.ts";
import { GitHubApiError } from "../errors.ts";
import {
  buildSubjectBatchQuery,
  errorsByAlias,
  parseStickies,
  parseSubjectAlias,
  parseTimelinePage,
  splitRepo,
} from "./subject-batch.ts";

const markers = [REPLAY_QA_MARKER, DIFFLOUPE_MARKER];
const ctx = { fetchedAt: "2026-11-23T12:00:00Z", markers };

function prNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "PR_1",
    number: 1,
    title: "Fix it",
    state: "OPEN",
    isDraft: false,
    author: { login: "alice", __typename: "User" },
    body: "Fixes the **crash**",
    baseRefName: "main",
    headRefName: "fix",
    baseRefOid: "base-sha",
    headRefOid: "head-sha",
    updatedAt: "2026-11-23T11:00:00Z",
    reviewThreads: {
      nodes: [{ id: "RT_1", isResolved: false, isOutdated: false, path: "a.ts", line: 3, comments: { nodes: [] } }],
    },
    timelineItems: {
      pageInfo: { hasNextPage: false, endCursor: "c1" },
      nodes: [
        {
          __typename: "IssueComment",
          id: "IC_1",
          createdAt: "2026-11-23T10:00:00Z",
          body: "looks good",
          lastEditedAt: null,
          author: { login: "bob", __typename: "User" },
        },
        {
          __typename: "IssueComment",
          id: "IC_2",
          createdAt: "2026-11-23T10:05:00Z",
          body: "### Review\n<!-- ai-review kind=summary head=abc -->",
          lastEditedAt: "2026-11-23T10:06:00Z",
          author: { login: "github-actions", __typename: "Bot" },
        },
        {
          __typename: "PullRequestCommit",
          id: "PRC_1",
          commit: { oid: "c0ffee", committedDate: "2026-11-23T09:00:00Z" },
        },
        { __typename: "HeadRefDeletedEvent", id: "HRD_1", createdAt: "2026-11-23T10:10:00Z" },
        { __typename: "IssueComment", id: "IC_1", createdAt: "2026-11-23T10:00:00Z", body: "dupe", author: null },
        { __typename: "SomeFutureThing" },
      ],
    },
    ...overrides,
  };
}

describe("buildSubjectBatchQuery", () => {
  test("mixed PR and issue batch with stickies", () => {
    const built = buildSubjectBatchQuery({
      repo: "octo/repo",
      subjects: [
        { subjectKey: "octo/repo#1", kind: "pr", number: 1, since: "2026-11-20T00:00:00.000Z" },
        { subjectKey: "octo/repo#2", kind: "pr", number: 2, since: null },
        { subjectKey: "octo/repo#3", kind: "pr", number: 3, since: null },
        { subjectKey: "octo/repo#4", kind: "issue", number: 4, since: "2026-11-21T00:00:00.000Z" },
      ],
      stickyIds: ["IC_9"],
      shape: queryShape("full", false),
    });
    expect(built.aliases).toEqual(["s0", "s1", "s2", "s3"]);
    expect(built.variables).toEqual({ owner: "octo", name: "repo", stickyIds: ["IC_9"] });
    expect(built.query).toContain(
      's0: pullRequest(number: 1) { ...PrCore timelineItems(since: "2026-11-20T00:00:00.000Z", first: 100)',
    );
    expect(built.query).toContain("s1: pullRequest(number: 2) { ...PrCore timelineItems(first: 100)");
    expect(built.query).toContain('s3: issue(number: 4) { ...IssueCore timelineItems(since: "2026-11-21T00:00:00.000Z"');
    expect(built.query).toContain("stickies: nodes(ids: $stickyIds)");
    for (const fragment of ["PrCore", "PrItems", "IssueCore", "IssueItems"]) {
      expect(built.query).toContain(`fragment ${fragment} on`);
    }
    for (const banned of ["files", "changedFiles", "additions", "deletions", "totalCount"]) {
      expect(built.query).not.toMatch(new RegExp(`\\b${banned}\\b`));
    }
    expect(built.query).toMatchSnapshot();
  });

  test("PR-only batch defines no issue fragments", () => {
    const { query } = buildSubjectBatchQuery({
      repo: "octo/repo",
      subjects: [{ subjectKey: "octo/repo#1", kind: "pr", number: 1, since: null }],
      stickyIds: [],
      shape: queryShape("full", false),
    });
    expect(query).not.toContain("fragment IssueCore");
    expect(query).not.toContain("fragment IssueItems");
  });

  test("page-only alias has no core fields and passes the cursor", () => {
    const { query } = buildSubjectBatchQuery({
      repo: "octo/repo",
      subjects: [{ subjectKey: "octo/repo#1", kind: "pr", number: 1, since: null, after: "cur" }],
      stickyIds: [],
      shape: queryShape("full", true),
    });
    expect(query).toContain('s0: pullRequest(number: 1) { timelineItems(first: 30, after: "cur")');
    expect(query).not.toContain("fragment PrCore");
    expect(query).toContain("fragment PrItems");
  });

  test("query shapes change checks and review threads", () => {
    const subjects = [{ subjectKey: "octo/repo#1", kind: "pr" as const, number: 1, since: null }];
    const full = buildSubjectBatchQuery({ repo: "o/r", subjects, stickyIds: [], shape: queryShape("full", false) });
    const reduced = buildSubjectBatchQuery({ repo: "o/r", subjects, stickyIds: [], shape: queryShape("full", true) });
    const simple = buildSubjectBatchQuery({ repo: "o/r", subjects, stickyIds: [], shape: queryShape("simple", false) });
    expect(full.query).toContain("contexts(first: 50)");
    expect(full.query).toContain("reviewThreads(last: 50)");
    expect(reduced.query).not.toContain("contexts(");
    expect(reduced.query).toContain("reviewThreads(last: 20)");
    expect(simple.query).not.toContain("contexts(");
    expect(simple.query).not.toContain("reviewThreads");
  });

  test("splitRepo rejects bad names", () => {
    expect(splitRepo("a/b")).toEqual({ owner: "a", name: "b" });
    expect(() => splitRepo("a")).toThrow();
    expect(() => splitRepo("a/b/c")).toThrow();
  });
});

describe("parseSubjectAlias", () => {
  test("maps a PR, keeps unknown types raw, dedupes, finds stickies", () => {
    const parsed = parseSubjectAlias(prNode(), "pr", ctx);
    expect(parsed.subject).toMatchObject({
      nodeId: "PR_1",
      state: "OPEN",
      author: "alice",
      headRef: "fix",
      baseRef: "main",
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    expect(parsed.subject.raw).not.toHaveProperty("timelineItems");
    expect(parsed.subject.raw).not.toHaveProperty("reviewThreads");
    expect(parsed.subject.raw).toHaveProperty("title", "Fix it");
    expect(parsed.subject.raw).toHaveProperty("body", "Fixes the **crash**");
    expect(parsed.items.map((i) => [i.nodeId, i.typename, i.createdAt])).toEqual([
      ["IC_1", "IssueComment", "2026-11-23T10:00:00Z"],
      ["IC_2", "IssueComment", "2026-11-23T10:05:00Z"],
      ["PRC_1", "PullRequestCommit", "2026-11-23T09:00:00Z"],
      ["HRD_1", "HeadRefDeletedEvent", "2026-11-23T10:10:00Z"],
    ]);
    expect(parsed.stickies).toEqual([
      {
        commentNodeId: "IC_2",
        author: "github-actions",
        lastEditedAt: "2026-11-23T10:06:00Z",
        body: "### Review\n<!-- ai-review kind=summary head=abc -->",
      },
    ]);
    expect(parsed.reviewThreads).toEqual([
      {
        nodeId: "RT_1",
        isResolved: false,
        isOutdated: false,
        path: "a.ts",
        line: 3,
        raw: { id: "RT_1", isResolved: false, isOutdated: false, path: "a.ts", line: 3, comments: { nodes: [] } },
      },
    ]);
    expect(parsed.hasNextPage).toBe(false);
  });

  test("omits review threads when the query skipped them", () => {
    const { reviewThreads: _skip, ...node } = prNode();
    expect(parseSubjectAlias(node, "pr", ctx).reviewThreads).toBeUndefined();
  });

  test("falls back to fetch time for items without a date", () => {
    const node = prNode({
      timelineItems: { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [{ __typename: "Odd", id: "X_1" }] },
    });
    const parsed = parseSubjectAlias(node, "pr", ctx);
    expect(parsed.items[0]?.createdAt).toBe(ctx.fetchedAt);
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.endCursor).toBe("next");
  });

  test("maps an issue", () => {
    const parsed = parseSubjectAlias(
      {
        id: "I_4",
        number: 4,
        state: "CLOSED",
        stateReason: "COMPLETED",
        author: null,
        updatedAt: "2026-11-23T11:00:00Z",
        timelineItems: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ __typename: "ClosedEvent", id: "CE_1", createdAt: "2026-11-23T10:00:00Z" }],
        },
      },
      "issue",
      ctx,
    );
    expect(parsed.subject).toMatchObject({ nodeId: "I_4", state: "CLOSED", author: null, headRef: null, headSha: null });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.reviewThreads).toBeUndefined();
  });

  test("rejects a bad shape", () => {
    expect(() => parseSubjectAlias(prNode({ state: "WEIRD" }), "pr", ctx)).toThrow(GitHubApiError);
    const badComment = prNode({
      timelineItems: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ __typename: "IssueComment", id: "IC_1", createdAt: "x", author: null }],
      },
    });
    expect(() => parseSubjectAlias(badComment, "pr", ctx)).toThrow(/IssueComment/);
  });
});

describe("parseTimelinePage", () => {
  test("parses a page-only alias", () => {
    const page = parseTimelinePage(
      {
        timelineItems: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ __typename: "MergedEvent", id: "ME_1", createdAt: "2026-11-23T10:00:00Z" }],
        },
      },
      ctx,
    );
    expect(page.items.map((i) => i.nodeId)).toEqual(["ME_1"]);
  });

  test("skips null items", () => {
    const page = parseTimelinePage(
      {
        timelineItems: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [null, { __typename: "MergedEvent", id: "ME_1", createdAt: "2026-11-23T10:00:00Z" }, null],
        },
      },
      ctx,
    );
    expect(page.items.map((i) => i.nodeId)).toEqual(["ME_1"]);
  });
});

describe("parseStickies", () => {
  test("skips deleted and author-less comments", () => {
    const map = parseStickies([
      { id: "IC_1", body: "a", lastEditedAt: null, author: { login: "replay-qa", __typename: "Bot" } },
      null,
      {},
      { id: "IC_2", body: "b", lastEditedAt: null, author: null },
    ]);
    expect([...map.keys()]).toEqual(["IC_1"]);
    expect(map.get("IC_1")).toEqual({ commentNodeId: "IC_1", author: "replay-qa", lastEditedAt: null, body: "a" });
    expect(parseStickies(undefined).size).toBe(0);
  });
});

describe("errorsByAlias", () => {
  test("groups by alias path", () => {
    const grouped = errorsByAlias([
      { message: "nope", type: "NOT_FOUND", path: ["repository", "s1"] },
      { message: "other", path: ["stickies", 0] },
      { message: "plain" },
    ]);
    expect(grouped.get("s1")?.map((e) => e.type)).toEqual(["NOT_FOUND"]);
    expect(grouped.get("")?.map((e) => e.message)).toEqual(["other", "plain"]);
    expect(errorsByAlias(undefined).size).toBe(0);
  });
});
