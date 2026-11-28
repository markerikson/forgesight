import { describe, expect, test } from "bun:test";
import type { ContentRule } from "./config.ts";
import {
  DIFFLOUPE_MARKER,
  ENRICH_PRIORITY,
  enrichTier,
  enrichWorkClass,
  pickEnrichBatch,
  type PickEnrichOptions,
  type QueuedSubject,
  GROW_AFTER,
  initialBatchState,
  isExhausted,
  isStickyCandidate,
  needsFetchOnOpen,
  nextBatchSize,
  type OpenedSubject,
  queryShape,
  REPLAY_QA_MARKER,
  stickyMarkers,
  timelineSince,
} from "./enrich-plan.ts";

describe("nextBatchSize", () => {
  test("doubles after GROW_AFTER successes, capped at max", () => {
    let state = { size: 4, successes: 0, reduced: false };
    for (let i = 0; i < GROW_AFTER - 1; i++) state = nextBatchSize(state, "ok", 10);
    expect(state).toEqual({ size: 4, successes: GROW_AFTER - 1, reduced: false });
    state = nextBatchSize(state, "ok", 10);
    expect(state).toEqual({ size: 8, successes: 0, reduced: false });
    state = nextBatchSize({ ...state, successes: GROW_AFTER - 1 }, "ok", 10);
    expect(state.size).toBe(10);
  });

  test("halves on gateway errors and timeouts and resets the success count", () => {
    expect(nextBatchSize({ size: 10, successes: 7, reduced: false }, "gateway", 10)).toEqual({
      size: 5,
      successes: 0,
      reduced: false,
    });
    expect(nextBatchSize({ size: 5, successes: 0, reduced: false }, "timeout", 10).size).toBe(2);
    expect(nextBatchSize({ size: 2, successes: 0, reduced: false }, "gateway", 10).size).toBe(1);
  });

  test("size 1 failing switches to the reduced field set, then is exhausted", () => {
    const reduced = nextBatchSize({ size: 1, successes: 3, reduced: false }, "gateway", 10);
    expect(reduced).toEqual({ size: 1, successes: 0, reduced: true });
    expect(isExhausted(reduced)).toBe(true);
    expect(nextBatchSize(reduced, "timeout", 10)).toEqual(reduced);
  });

  test("reduced switches back to full fields after GROW_AFTER successes", () => {
    const state = nextBatchSize({ size: 1, successes: GROW_AFTER - 1, reduced: true }, "ok", 10);
    expect(state).toEqual({ size: 1, successes: 0, reduced: false });
  });

  test("a lowered max clamps the stored size", () => {
    expect(nextBatchSize(initialBatchState(10), "ok", 3).size).toBe(3);
    expect(isExhausted(initialBatchState(0))).toBe(false);
  });
});

test("queryShape", () => {
  expect(queryShape("full", false)).toEqual({ checks: "contexts", reviewThreads: 50, timelinePage: 100 });
  expect(queryShape("normal", true)).toEqual({ checks: "rollup", reviewThreads: 20, timelinePage: 30 });
  expect(queryShape("simple", false)).toEqual({ checks: "rollup", reviewThreads: 0, timelinePage: 100 });
});

describe("timelineSince", () => {
  const now = new Date("2026-11-23T12:00:00Z");

  test("continues 5 minutes before the last sync", () => {
    expect(timelineSince({ timelineSyncedUntil: "2026-11-23T10:00:00.000Z", dismissedAt: null, now })).toBe(
      "2026-11-23T09:55:00.000Z",
    );
  });

  test("first fetch starts a day before dismissal, covering at least two days", () => {
    expect(timelineSince({ timelineSyncedUntil: null, dismissedAt: "2026-11-01T00:00:00Z", now })).toBe(
      "2026-10-31T00:00:00.000Z",
    );
    expect(timelineSince({ timelineSyncedUntil: null, dismissedAt: "2026-11-23T11:00:00Z", now })).toBe(
      "2026-11-21T12:00:00.000Z",
    );
  });

  test("never dismissed fetches the whole timeline", () => {
    expect(timelineSince({ timelineSyncedUntil: null, dismissedAt: null, now })).toBeNull();
  });
});

describe("stickyMarkers", () => {
  const rule = (id: string, match: ContentRule["match"], findings?: string): ContentRule => {
    const r: ContentRule = { id, match, level: "collapsed", override: [], extract: [] } as unknown as ContentRule;
    if (findings) r.findings = findings;
    return r;
  };

  test("adds rules with findings and a marker, without duplicates", () => {
    const markers = stickyMarkers({
      bots: [
        rule("diffloupe", { author: "github-actions", htmlMarker: "ai-review kind=summary" }, "diffloupe"),
        rule("coverage", { htmlMarker: "<!-- coverage -->" }, "coverage"),
        rule("noise", { htmlMarker: "<!-- noise -->" }),
      ],
      contentRules: [rule("by-author", { author: "someone" }, "x")],
    });
    expect(markers).toEqual([DIFFLOUPE_MARKER, REPLAY_QA_MARKER, { marker: "<!-- coverage -->" }]);
  });
});

describe("isStickyCandidate", () => {
  const markers = [DIFFLOUPE_MARKER, REPLAY_QA_MARKER];
  const comment = (authorLogin: string | null, body: string, typename = "IssueComment") => ({
    typename,
    authorLogin,
    body,
  });
  const diffloupe = "### Review of `abc`\n\nFindings\n\n<!-- ai-review kind=summary head=abc -->";

  test("bot comments with their marker", () => {
    expect(isStickyCandidate(comment("github-actions", diffloupe), markers)).toBe(true);
    expect(isStickyCandidate(comment("github-actions[bot]", diffloupe), markers)).toBe(true);
    expect(isStickyCandidate(comment("replay-qa", "report\n<!-- replay-qa-bot -->"), markers)).toBe(true);
  });

  test("a marker tied to an author does not match other authors", () => {
    expect(isStickyCandidate(comment("markerikson", diffloupe), markers)).toBe(false);
  });

  test("markers inside code blocks or inline code do not count", () => {
    const fenced = "Look at this:\n\n```html\n<!-- replay-qa-bot -->\n```\n";
    expect(isStickyCandidate(comment("markerikson", fenced), markers)).toBe(false);
    expect(isStickyCandidate(comment("markerikson", "use `<!-- replay-qa-bot -->` here"), markers)).toBe(false);
    const tilde = "~~~\n<!-- replay-qa-bot -->\n~~~~\nafter";
    expect(isStickyCandidate(comment("markerikson", tilde), markers)).toBe(false);
    const unclosed = "```\n<!-- replay-qa-bot -->";
    expect(isStickyCandidate(comment("markerikson", unclosed), markers)).toBe(false);
    const after = "```\ncode\n```\n<!-- replay-qa-bot -->";
    expect(isStickyCandidate(comment("replay-qa", after), markers)).toBe(true);
  });

  test("only issue comments with an author", () => {
    expect(isStickyCandidate(comment("github-actions", diffloupe, "PullRequestReview"), markers)).toBe(false);
    expect(isStickyCandidate(comment(null, diffloupe), markers)).toBe(false);
  });
});

describe("enrichWorkClass", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

  test("recent threads are enrich, older ones backfill", () => {
    expect(enrichWorkClass({ origin: "thread", threadUpdatedAt: daysAgo(13), now })).toBe("enrich");
    expect(enrichWorkClass({ origin: "thread", threadUpdatedAt: daysAgo(15), now })).toBe("backfill");
  });

  test("no thread is backfill unless the subject came from a stack", () => {
    expect(enrichWorkClass({ origin: "open-list", threadUpdatedAt: null, now })).toBe("backfill");
    expect(enrichWorkClass({ origin: "stack", threadUpdatedAt: null, now })).toBe("enrich");
    expect(enrichWorkClass({ origin: "stack", threadUpdatedAt: daysAgo(60), now })).toBe("enrich");
  });

  test("issues in normal and full repos are enrich while open or updated in the last 30 days", () => {
    const issue = { origin: "thread", kind: "issue", now } as const;
    expect(enrichWorkClass({ ...issue, state: "OPEN", threadUpdatedAt: daysAgo(90), mode: "normal" })).toBe("enrich");
    expect(enrichWorkClass({ ...issue, state: "OPEN", threadUpdatedAt: null, mode: "full" })).toBe("enrich");
    expect(enrichWorkClass({ ...issue, state: "CLOSED", threadUpdatedAt: daysAgo(20), mode: "normal" })).toBe("enrich");
    expect(enrichWorkClass({ ...issue, state: "CLOSED", threadUpdatedAt: daysAgo(35), mode: "normal" })).toBe("backfill");
    expect(enrichWorkClass({ ...issue, state: null, threadUpdatedAt: daysAgo(20), mode: "normal" })).toBe("enrich");
  });

  test("issues in simple repos and pull requests keep the 14-day window", () => {
    expect(
      enrichWorkClass({ origin: "thread", kind: "issue", state: "OPEN", threadUpdatedAt: daysAgo(20), now, mode: "simple" }),
    ).toBe("backfill");
    expect(
      enrichWorkClass({ origin: "thread", kind: "pr", state: "OPEN", threadUpdatedAt: daysAgo(20), now, mode: "normal" }),
    ).toBe("backfill");
  });
});

describe("pickEnrichBatch", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
  const queued = (subjectKey: string, extra: Partial<QueuedSubject> = {}): QueuedSubject => ({
    subjectKey,
    repo: subjectKey.split("#")[0] ?? "",
    kind: "pr",
    state: null,
    origin: "thread",
    priority: 0,
    dirtyAt: daysAgo(1),
    threadUpdatedAt: daysAgo(1),
    ...extra,
  });
  const opts = (extra: Partial<PickEnrichOptions> = {}): PickEnrichOptions => ({
    canSpend: () => true,
    batchSize: () => 10,
    mode: () => "normal",
    ...extra,
  });

  test("tiers: urgent, then recent activity, then backlog", () => {
    const tier = (subject: QueuedSubject) => enrichTier(subject, now, "normal");
    expect(tier(queued("a/x#1", { priority: ENRICH_PRIORITY.urgent, threadUpdatedAt: null }))).toBe("urgent");
    expect(tier(queued("a/x#1"))).toBe("active");
    expect(tier(queued("a/x#1", { origin: "stack", threadUpdatedAt: null }))).toBe("active");
    expect(tier(queued("a/x#1", { threadUpdatedAt: daysAgo(30) }))).toBe("backlog");
    expect(tier(queued("a/x#1", { threadUpdatedAt: null }))).toBe("backlog");
    expect(tier(queued("a/x#2", { kind: "issue", state: "OPEN", threadUpdatedAt: daysAgo(60) }))).toBe("active");
    expect(enrichTier(queued("a/x#2", { kind: "issue", state: "OPEN", threadUpdatedAt: daysAgo(60) }), now, "simple")).toBe(
      "backlog",
    );
  });

  test("orders across repos by tier before repo or age", () => {
    const queue = [
      queued("old/repo#1", { dirtyAt: daysAgo(10), threadUpdatedAt: daysAgo(40) }),
      queued("old/repo#2", { dirtyAt: daysAgo(9), threadUpdatedAt: null }),
      queued("new/repo#5", { dirtyAt: daysAgo(1) }),
      queued("other/repo#9", { dirtyAt: daysAgo(0), priority: ENRICH_PRIORITY.urgent, threadUpdatedAt: daysAgo(90) }),
    ];
    expect(pickEnrichBatch(queue, now, opts())).toEqual({
      repo: "other/repo",
      tier: "urgent",
      workClass: "enrich",
      keys: ["other/repo#9"],
    });
    expect(pickEnrichBatch(queue.slice(0, 3), now, opts())).toEqual({
      repo: "new/repo",
      tier: "active",
      workClass: "enrich",
      keys: ["new/repo#5"],
    });
    expect(pickEnrichBatch(queue.slice(0, 2), now, opts())).toEqual({
      repo: "old/repo",
      tier: "backlog",
      workClass: "backfill",
      keys: ["old/repo#1", "old/repo#2"],
    });
  });

  test("within a tier, higher priority then older dirty_at go first; batch stays in one repo and tier", () => {
    const queue = [
      queued("a/x#1", { dirtyAt: daysAgo(3) }),
      queued("b/y#1", { dirtyAt: daysAgo(1), priority: ENRICH_PRIORITY.direct }),
      queued("a/x#2", { dirtyAt: daysAgo(2), priority: ENRICH_PRIORITY.direct }),
      queued("a/x#3", { dirtyAt: daysAgo(5), threadUpdatedAt: daysAgo(40) }),
      queued("a/x#4", { dirtyAt: daysAgo(1) }),
    ];
    expect(pickEnrichBatch(queue, now, opts({ batchSize: () => 2 }))?.keys).toEqual(["a/x#2", "a/x#1"]);
    expect(pickEnrichBatch(queue, now, opts())?.keys).toEqual(["a/x#2", "a/x#1", "a/x#4"]);
  });

  test("skips tiers the budget does not allow, and limits to the requested tiers", () => {
    const queue = [queued("a/x#1", { threadUpdatedAt: daysAgo(40) }), queued("b/y#1")];
    const noBackfill = opts({ canSpend: (cls) => cls !== "backfill" });
    expect(pickEnrichBatch([queue[0] as QueuedSubject], now, noBackfill)).toBeNull();
    expect(pickEnrichBatch(queue, now, opts({ canSpend: () => false }))).toBeNull();
    expect(pickEnrichBatch(queue, now, opts({ tiers: ["urgent"] }))).toBeNull();
    expect(pickEnrichBatch(queue, now, opts({ tiers: ["backlog"] }))?.keys).toEqual(["a/x#1"]);
  });
});

describe("needsFetchOnOpen", () => {
  const polling = (enrichIssues: boolean) => ({ polling: { enrichIssues } }) as Parameters<typeof needsFetchOnOpen>[1];
  const fetched: OpenedSubject = {
    kind: "pr",
    timelineSyncedUntil: "2026-11-20T00:00:00.000Z",
    enrichError: null,
    missingBody: false,
    threadUpdatedAt: "2026-11-19T00:00:00.000Z",
  };
  const needs = (over: Partial<OpenedSubject>, enrichIssues = true) =>
    needsFetchOnOpen({ ...fetched, ...over }, polling(enrichIssues));

  test("fetches subjects never fetched, fetched without a body, or with newer notifications", () => {
    expect(needs({})).toBe(false);
    expect(needs({ timelineSyncedUntil: null })).toBe(true);
    expect(needs({ missingBody: true })).toBe(true);
    expect(needs({ threadUpdatedAt: "2026-11-21T00:00:00.000Z" })).toBe(true);
    expect(needs({ threadUpdatedAt: null })).toBe(false);
  });

  test("skips failed fetches and kinds the worker does not fetch", () => {
    expect(needs({ timelineSyncedUntil: null, enrichError: "not_found" })).toBe(false);
    expect(needs({ kind: "other", timelineSyncedUntil: null })).toBe(false);
    expect(needs({ kind: "issue", timelineSyncedUntil: null })).toBe(true);
    expect(needs({ kind: "issue", timelineSyncedUntil: null }, false)).toBe(false);
  });
});
