import { describe, expect, test } from "bun:test";
import type { UserConfig } from "../config/schema.ts";
import { resolveConfig } from "../config/load.ts";
import { batchMetaKey, openPullsMetaKey } from "../core/meta-keys.ts";
import type { SubjectKind, SubjectOrigin } from "../core/types.ts";
import { Governor, MemoryApiCallLog } from "../github/budget.ts";
import { RateLimitedError } from "../github/errors.ts";
import { FakeGitHubClient } from "../github/fake.ts";
import type { GqlResult } from "../github/types.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { ensureSubjects, getSubject, markDirty } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { upsertThreads } from "../store/threads.ts";
import { timelineFor } from "../store/timeline.ts";
import { enrichJob, loadBatchState } from "./enrich.ts";
import { openPullsJob } from "./open-pulls.ts";
import type { JobContext, Logger } from "./scheduler.ts";

const REPO = "octo/repo";
const START = new Date("2026-11-23T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const quietLog: Logger = { info() {}, warn() {}, error() {} };

function pr(number: number) {
  return {
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    state: "OPEN",
    author: { login: "alice", __typename: "User" },
    baseRefName: "main",
    headRefName: `b${number}`,
    baseRefOid: "base",
    headRefOid: `head${number}`,
    updatedAt: "2026-11-23T11:00:00Z",
    reviewThreads: { nodes: [] },
    timelineItems: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ __typename: "LabeledEvent", id: `L_${number}`, createdAt: "2026-11-23T09:00:00Z" }],
    },
  };
}

function ok(data: unknown): GqlResult<unknown> {
  return { data, cost: 1, remaining: 4000, resetAt: START, gatewayErrors: 0 };
}

/** Subject numbers asked for, by alias. */
function requested(query: string): Array<{ alias: string; number: number }> {
  return [...query.matchAll(/(s\d+): (?:pullRequest|issue)\(number: (\d+)\)/g)].map((m) => ({
    alias: m[1] ?? "",
    number: Number(m[2]),
  }));
}

interface SubjectSpec {
  number: number;
  kind?: SubjectKind;
  origin?: SubjectOrigin;
  /** Age of the newest notification thread; none when omitted. */
  threadAgeDays?: number;
  repo?: string;
}

function setup(subjects: SubjectSpec[], user: UserConfig = {}) {
  let now = START;
  const clock = () => now;
  const db = memoryDb();
  const config = resolveConfig(user);
  const gh = new FakeGitHubClient(clock);
  const apiLog = new MemoryApiCallLog();
  const governor = new Governor(apiLog, config.budget, clock);
  const key = (s: SubjectSpec) => `${s.repo ?? REPO}#${s.number}`;
  ensureSubjects(
    db,
    subjects.map((s) => ({
      subjectKey: key(s),
      repo: s.repo ?? REPO,
      number: s.number,
      kind: s.kind ?? "pr",
      origin: s.origin ?? "thread",
    })),
  );
  upsertThreads(
    db,
    subjects
      .filter((s) => s.threadAgeDays !== undefined)
      .map((s) => ({
        threadId: `T${s.number}`,
        subjectKey: key(s),
        repo: s.repo ?? REPO,
        subjectType: "PullRequest",
        reason: "review_requested",
        unread: true,
        updatedAt: new Date(START.getTime() - (s.threadAgeDays ?? 0) * DAY_MS).toISOString(),
        lastReadAt: null,
        subjectUrl: null,
        raw: {},
      })),
    START.toISOString(),
  );
  markDirty(db, subjects.map(key), START.toISOString());
  gh.graphqlHandler = (query) => {
    const repository: Record<string, unknown> = {};
    for (const r of requested(query)) repository[r.alias] = pr(r.number);
    return ok({ repository, stickies: [] });
  };
  const ctx: JobContext = { db, gh, governor, config, clock, log: quietLog };
  return {
    db,
    gh,
    ctx,
    apiLog,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    graphqlCalls: () => gh.calls.filter((c) => c.method === "graphql"),
  };
}

function isDirty(db: ReturnType<typeof memoryDb>, key: string): boolean {
  return getSubject(db, key)?.dirtyAt != null;
}

describe("enrichJob", () => {
  test("clears kind other without fetching, then goes idle", async () => {
    const t = setup([{ number: 1, kind: "other", threadAgeDays: 1 }]);
    expect(await enrichJob.run(t.ctx)).toBe("worked");
    expect(isDirty(t.db, `${REPO}#1`)).toBe(false);
    expect(t.graphqlCalls()).toHaveLength(0);
    expect(await enrichJob.run(t.ctx)).toBe("idle");
  });

  test("clears issues when enrichIssues is off", async () => {
    const t = setup([{ number: 1, kind: "issue", threadAgeDays: 1 }], { polling: { enrichIssues: false } });
    expect(await enrichJob.run(t.ctx)).toBe("worked");
    expect(isDirty(t.db, `${REPO}#1`)).toBe(false);
    expect(t.graphqlCalls()).toHaveLength(0);
  });

  test("enriches a batch, stores the timeline, clears dirty and saves batch state", async () => {
    const t = setup([
      { number: 1, threadAgeDays: 1 },
      { number: 2, threadAgeDays: 2 },
    ]);
    expect(await enrichJob.run(t.ctx)).toBe("worked");
    const calls = t.graphqlCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method === "graphql" && calls[0].opts.workClass).toBe("enrich");
    for (const n of [1, 2]) {
      expect(isDirty(t.db, `${REPO}#${n}`)).toBe(false);
      expect(timelineFor(t.db, `${REPO}#${n}`).map((i) => i.nodeId)).toEqual([`L_${n}`]);
    }
    expect(JSON.parse(getMeta(t.db, batchMetaKey(REPO)) ?? "null")).toMatchObject({ size: 10, successes: 1 });
    expect(await enrichJob.run(t.ctx)).toBe("idle");
  });

  test("a rate limit mid-run saves what was fetched and rethrows the rate limit", async () => {
    const t = setup([
      { number: 1, threadAgeDays: 1 },
      { number: 2, threadAgeDays: 1 },
    ]);
    let calls = 0;
    t.gh.graphqlHandler = (query) => {
      calls += 1;
      if (calls > 1) throw new RateLimitedError("secondary limit", new Date(START.getTime() + 60_000), true);
      const repository: Record<string, unknown> = {};
      for (const r of requested(query)) {
        const node = pr(r.number);
        const morePages = { ...node.timelineItems, pageInfo: { hasNextPage: true, endCursor: "c1" } };
        repository[r.alias] = r.number === 2 ? { ...node, timelineItems: morePages } : node;
      }
      return ok({ repository, stickies: [] });
    };

    await expect(enrichJob.run(t.ctx)).rejects.toBeInstanceOf(RateLimitedError);
    expect(isDirty(t.db, `${REPO}#1`)).toBe(false);
    expect(isDirty(t.db, `${REPO}#2`)).toBe(true);
    expect(JSON.parse(getMeta(t.db, batchMetaKey(REPO)) ?? "null")).toMatchObject({ size: 10, successes: 1 });
  });

  test("uses the stored batch size for the repo", async () => {
    const t = setup([1, 2, 3].map((number) => ({ number, threadAgeDays: 1 })));
    setMeta(t.db, batchMetaKey(REPO), JSON.stringify({ size: 2, successes: 0, reduced: true }), START.toISOString());
    await enrichJob.run(t.ctx);
    const [call] = t.graphqlCalls();
    expect(call?.method === "graphql" && requested(call.query).map((r) => r.number)).toEqual([1, 2]);
    expect(isDirty(t.db, `${REPO}#3`)).toBe(true);
  });

  test("subjects with old or missing threads are backfill; stack subjects are enrich", async () => {
    const t = setup([
      { number: 1, threadAgeDays: 30 },
      { number: 2 },
      { number: 3, origin: "stack" },
    ]);
    await enrichJob.run(t.ctx);
    await enrichJob.run(t.ctx);
    const classes = t.graphqlCalls().map((c) => (c.method === "graphql" ? [c.opts.workClass, requested(c.query).map((r) => r.number)] : null));
    expect(classes).toEqual([
      ["backfill", [1, 2]],
      ["enrich", [3]],
    ]);
  });

  test("past the soft cap, backfill subjects wait while recent ones go ahead", async () => {
    const t = setup([
      { number: 1, threadAgeDays: 30 },
      { number: 2, threadAgeDays: 1 },
    ]);
    t.apiLog.append({
      at: START,
      resource: "graphql",
      workClass: "enrich",
      request: "graphql octo/repo",
      status: 200,
      cost: 900,
      remaining: null,
      resetAt: null,
      durationMs: 1,
    });
    expect(await enrichJob.run(t.ctx)).toBe("worked");
    const [call] = t.graphqlCalls();
    expect(call?.method === "graphql" && requested(call.query).map((r) => r.number)).toEqual([2]);
    expect(isDirty(t.db, `${REPO}#1`)).toBe(true);
    expect(await enrichJob.run(t.ctx)).toBe("idle");
    expect(isDirty(t.db, `${REPO}#1`)).toBe(true);
  });

  test("moves on to the next repo when the governor blocks every subject in the top one", async () => {
    const t = setup([
      { number: 1, threadAgeDays: 30, repo: "a/old" },
      { number: 2, threadAgeDays: 1 },
    ]);
    t.apiLog.append({
      at: START,
      resource: "graphql",
      workClass: "enrich",
      request: "graphql octo/repo",
      status: 200,
      cost: 900,
      remaining: null,
      resetAt: null,
      durationMs: 1,
    });
    expect(await enrichJob.run(t.ctx)).toBe("worked");
    const [call] = t.graphqlCalls();
    expect(call?.method === "graphql" && call.variables).toMatchObject({ owner: "octo", name: "repo" });
    expect(isDirty(t.db, `${REPO}#2`)).toBe(false);
    expect(isDirty(t.db, "a/old#1")).toBe(true);
    expect(await enrichJob.run(t.ctx)).toBe("idle");
  });
});

describe("loadBatchState", () => {
  test("falls back to the configured size and clamps a stored size to it", () => {
    const db = memoryDb();
    expect(loadBatchState(db, REPO, 10)).toEqual({ size: 10, successes: 0, reduced: false });
    setMeta(db, batchMetaKey(REPO), JSON.stringify({ size: 25, successes: 4, reduced: false }), START.toISOString());
    expect(loadBatchState(db, REPO, 10)).toEqual({ size: 10, successes: 4, reduced: false });
    setMeta(db, batchMetaKey(REPO), "not json", START.toISOString());
    expect(loadBatchState(db, REPO, 10).size).toBe(10);
  });
});

describe("openPullsJob", () => {
  function openPullsSetup() {
    const t = setup([], { repos: { "octo/full": { mode: "full" }, "octo/normal": { mode: "normal" } } });
    t.gh.graphqlHandler = (_query, variables) =>
      ok({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: `PR in ${String(variables.name)}`,
                author: { login: "alice", __typename: "User" },
                headRefName: "feature",
                baseRefName: "main",
                headRefOid: "abc",
                updatedAt: "2026-11-23T11:00:00Z",
                isDraft: false,
              },
            ],
          },
        },
      });
    return t;
  }

  test("lists open PRs for full-mode repos only and stores the listing", async () => {
    const t = openPullsSetup();
    expect(await openPullsJob.run(t.ctx)).toBe("worked");
    const listing = JSON.parse(getMeta(t.db, openPullsMetaKey("octo/full")) ?? "null");
    expect(listing).toMatchObject({ repo: "octo/full", fetchedAt: START.toISOString(), pulls: [{ number: 7, headSha: "abc" }] });
    expect(getMeta(t.db, openPullsMetaKey("octo/normal"))).toBeUndefined();
    const [call] = t.graphqlCalls();
    expect(call?.method === "graphql" && call.opts.workClass).toBe("openPulls");
  });

  test("waits openPullsMinutes before listing again", async () => {
    const t = openPullsSetup();
    await openPullsJob.run(t.ctx);
    t.advance(9 * 60_000);
    expect(await openPullsJob.run(t.ctx)).toBe("idle");
    t.advance(60_000);
    expect(await openPullsJob.run(t.ctx)).toBe("worked");
    expect(t.graphqlCalls()).toHaveLength(2);
  });
});
