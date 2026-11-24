import { describe, expect, test } from "bun:test";
import type { ContentRule } from "./config.ts";
import {
  DIFFLOUPE_MARKER,
  enrichWorkClass,
  GROW_AFTER,
  initialBatchState,
  isExhausted,
  isStickyCandidate,
  nextBatchSize,
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
});
