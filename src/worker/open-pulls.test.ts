import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import { recentlyClosedMetaKey } from "../core/meta-keys.ts";
import { Governor, MemoryApiCallLog } from "../github/budget.ts";
import { FakeGitHubClient } from "../github/fake.ts";
import type { GqlResult } from "../github/types.ts";
import { getMeta } from "../store/meta.ts";
import { getSubject } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { changesAfter } from "../store/views.ts";
import { DEFAULT_WORKSTREAM_STATE } from "../core/workstream-state.ts";
import { getWorkstream, listWorkstreams, putWorkstreamState } from "../store/workstreams.ts";
import { openPullsJob } from "./open-pulls.ts";
import type { JobContext, Logger } from "./scheduler.ts";

const REPO = "octo/stack";
const START = new Date("2026-11-23T12:00:00Z");
const quietLog: Logger = { info() {}, warn() {}, error() {} };

interface Pull {
  number: number;
  author: string;
  head: string;
  base: string;
}

function node(p: Pull) {
  return {
    number: p.number,
    title: `PR ${p.number}`,
    author: { login: p.author, __typename: "User" },
    headRefName: p.head,
    baseRefName: p.base,
    headRefOid: `sha${p.number}`,
    updatedAt: "2026-11-23T11:00:00Z",
    isDraft: false,
  };
}

function ok(data: unknown): GqlResult<unknown> {
  return { data, cost: 1, remaining: 4000, resetAt: START, gatewayErrors: 0 };
}

function setup(initial: Pull[]) {
  let now = START;
  let pulls = initial;
  const clock = () => now;
  const db = memoryDb();
  const config = resolveConfig({ me: "mark", repos: { [REPO]: { view: "overview" } } });
  const gh = new FakeGitHubClient(clock);
  gh.graphqlHandler = () =>
    ok({
      repository: {
        pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pulls.map(node) },
      },
    });
  const governor = new Governor(new MemoryApiCallLog(), config.budget, clock);
  const ctx: JobContext = { db, gh, governor, config, clock, log: quietLog };
  return {
    db,
    ctx,
    setPulls(next: Pull[]) {
      pulls = next;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

const STACK: Pull[] = [
  { number: 10, author: "mark", head: "a", base: "main" },
  { number: 11, author: "mark", head: "b", base: "a" },
  { number: 12, author: "alice", head: "c", base: "main" },
];

describe("openPullsJob with view: overview", () => {
  test("builds workstreams and turns members of shown ones into stack subjects", async () => {
    const t = setup(STACK);
    expect(await openPullsJob.run(t.ctx)).toBe("worked");

    const [ws, ...rest] = listWorkstreams(t.db, REPO);
    expect(rest).toEqual([]);
    expect(ws).toMatchObject({ id: `${REPO}:ws:10`, closed: false });
    expect(ws?.members.map((m) => [m.key, m.parent, m.listingOnly])).toEqual([
      [`${REPO}#10`, null, false],
      [`${REPO}#11`, `${REPO}#10`, false],
    ]);
    expect(getSubject(t.db, `${REPO}#10`)).toMatchObject({ origin: "stack", kind: "pr" });
    expect(getSubject(t.db, `${REPO}#10`)?.dirtyAt).not.toBeNull();
    expect(getSubject(t.db, `${REPO}#12`)).toBeUndefined();

    const stackChanges = changesAfter(t.db, 0).filter((c) => c.kind === "stack");
    expect(stackChanges.map((c) => c.subjectKey).sort()).toEqual([`${REPO}#10`, `${REPO}#11`]);
  });

  test("members of a seen workstream nobody involves Mark in stay listing-only", async () => {
    const t = setup([
      { number: 20, author: "alice", head: "x", base: "main" },
      { number: 21, author: "alice", head: "y", base: "x" },
    ]);
    putWorkstreamState(
      t.db,
      `${REPO}:ws:20`,
      { ...DEFAULT_WORKSTREAM_STATE, seenAt: START.toISOString() },
      START.toISOString(),
    );
    await openPullsJob.run(t.ctx);
    const ws = getWorkstream(t.db, `${REPO}:ws:20`);
    expect(ws?.members.every((m) => m.listingOnly)).toBe(true);
    expect(getSubject(t.db, `${REPO}#20`)).toBeUndefined();
  });

  test("keeps PRs that left the listing as recently closed for 7 days", async () => {
    const t = setup(STACK);
    await openPullsJob.run(t.ctx);
    t.setPulls(STACK.filter((p) => p.number !== 11));
    t.advance(60 * 60_000);
    await openPullsJob.run(t.ctx);

    const closed = JSON.parse(getMeta(t.db, recentlyClosedMetaKey(REPO)) ?? "[]");
    expect(closed).toMatchObject([{ pull: { number: 11, closed: "closed" } }]);
    expect(getWorkstream(t.db, `${REPO}:ws:10`)?.members.map((m) => m.key)).toEqual([
      `${REPO}#10`,
      `${REPO}#11`,
    ]);

    t.advance(8 * 24 * 60 * 60_000);
    await openPullsJob.run(t.ctx);
    expect(JSON.parse(getMeta(t.db, recentlyClosedMetaKey(REPO)) ?? "[]")).toEqual([]);
    expect(getWorkstream(t.db, `${REPO}:ws:10`)).toBeUndefined();
  });
});
