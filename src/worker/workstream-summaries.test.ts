import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import type { UserConfig } from "../config/schema.ts";
import { openPullsMetaKey } from "../core/meta-keys.ts";
import type { Workstream } from "../core/workstreams.ts";
import { Governor, MemoryApiCallLog } from "../github/budget.ts";
import { FakeGitHubClient } from "../github/fake.ts";
import type { OpenPull, OpenPullsListing } from "../github/queries/open-pulls.ts";
import { FakeLlmClient } from "../llm/fake.ts";
import { LlmError } from "../llm/types.ts";
import { latestWorkstreamSummaries, llmSpendSince } from "../store/llm.ts";
import { setMeta } from "../store/meta.ts";
import { getPrTexts } from "../store/pr-texts.ts";
import { memoryDb } from "../store/test-db.ts";
import { writeWorkstreams } from "../store/workstreams.ts";
import type { JobContext, Logger } from "./scheduler.ts";
import { createWorkstreamSummariesJob, LLM_MAX_ATTEMPTS } from "./workstream-summaries.ts";

const REPO = "acme/app";
const HOUR = 60 * 60_000;
const quietLog: Logger = { info() {}, warn() {}, error() {} };

interface Pr {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
}

function setup(user: UserConfig = {}) {
  let now = new Date("2026-11-24T12:00:00.000Z");
  const clock = () => now;
  const config = resolveConfig(user);
  const db = memoryDb();
  const gh = new FakeGitHubClient(clock);
  const prs = new Map<number, Pr>();
  gh.graphqlHandler = (query) => {
    const repository: Record<string, unknown> = {};
    for (const [, alias, n] of query.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)) {
      const pr = prs.get(Number(n));
      repository[alias as string] = pr
        ? { number: pr.number, title: pr.title, bodyText: pr.body, updatedAt: pr.updatedAt, isDraft: false, state: "OPEN" }
        : null;
    }
    return { data: { repository }, cost: 1, remaining: 4000, resetAt: new Date(now.getTime() + HOUR), gatewayErrors: 0 };
  };
  const ctx: JobContext = {
    db,
    gh,
    governor: new Governor(new MemoryApiCallLog(), config.budget, clock),
    config,
    clock,
    log: quietLog,
  };
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const setPr = (pr: Pr) => {
    prs.set(pr.number, pr);
    writeListing(db, [...prs.values()], now.toISOString());
  };
  return { db, gh, ctx, prs, setPr, advance, clock };
}

function writeListing(db: Database, prs: Pr[], at: string): void {
  const pulls: OpenPull[] = prs.map((p) => ({
    number: p.number,
    title: p.title,
    author: "mark",
    authorType: "User",
    headRef: `branch-${p.number}`,
    baseRef: "main",
    headSha: `sha${p.number}`,
    updatedAt: p.updatedAt,
    isDraft: false,
  }));
  const listing: OpenPullsListing = { repo: REPO, fetchedAt: at, pulls };
  setMeta(db, openPullsMetaKey(REPO), JSON.stringify(listing), at);
}

function workstream(id: number, members: number[]): Workstream {
  return {
    id: `${REPO}:ws:${id}`,
    repo: REPO,
    name: `stack ${id}`,
    nameSource: "title",
    members: members.map((n) => `${REPO}#${n}`),
    edges: [],
    signals: ["stack"],
    author: "mark",
    prefix: null,
    closed: false,
    closedAt: null,
  };
}

function pr(number: number, updatedAt = "2026-11-24T10:00:00Z"): Pr {
  return { number, title: `Step ${number}`, body: `Does step ${number}.`, updatedAt };
}

describe("workstream summaries job", () => {
  test("fetches member texts, summarizes once, then stays idle", async () => {
    const { db, gh, ctx, setPr } = setup();
    setPr(pr(1));
    setPr(pr(2));
    const llm = new FakeLlmClient(() => ({ name: "Auth rework", summary: "Moves login to tokens." }));
    const job = createWorkstreamSummariesJob({ llm, workstreams: () => [workstream(1, [1, 2])] });

    expect(await job.run(ctx)).toBe("worked");
    expect(gh.calls).toHaveLength(1);
    expect([...getPrTexts(db, REPO, [1, 2]).keys()]).toEqual([1, 2]);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.model).toBe("claude-haiku-4-5");
    expect(llm.requests[0]?.user).toContain("## #1 Step 1");

    const summary = latestWorkstreamSummaries(db).get(`${REPO}:ws:1`);
    expect(summary).toMatchObject({ name: "Auth rework", text: "Moves login to tokens.", status: null });
    // 1000 input + 100 output tokens at Haiku prices
    expect(llmSpendSince(db, "2026-11-24T00:00:00.000Z")).toBeCloseTo(0.0015, 6);

    expect(await job.run(ctx)).toBe("idle");
    expect(gh.calls).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
  });

  test("without an LLM client it only syncs texts", async () => {
    const { db, ctx, setPr } = setup();
    setPr(pr(1));
    const job = createWorkstreamSummariesJob({ llm: null, workstreams: () => [workstream(1, [1])] });
    expect(await job.run(ctx)).toBe("worked");
    expect(getPrTexts(db, REPO, [1]).size).toBe(1);
    expect(await job.run(ctx)).toBe("idle");
    expect(latestWorkstreamSummaries(db).size).toBe(0);
  });

  test("a description change waits out the 6 hour interval; a push alone never resummarizes", async () => {
    const { db, gh, ctx, setPr, advance } = setup();
    setPr(pr(1));
    const llm = new FakeLlmClient();
    const job = createWorkstreamSummariesJob({ llm, workstreams: () => [workstream(1, [1])] });
    await job.run(ctx);
    expect(llm.requests).toHaveLength(1);

    // A push bumps updatedAt: texts are refetched, but the input hash is unchanged.
    advance(7 * HOUR);
    setPr(pr(1, "2026-11-24T18:00:00Z"));
    await job.run(ctx);
    expect(gh.calls).toHaveLength(2);
    expect(llm.requests).toHaveLength(1);

    // The first summary is 7 hours old, so an edited description summarizes right away.
    setPr({ ...pr(1, "2026-11-24T19:00:00Z"), body: "Now also does step 1b." });
    await job.run(ctx);
    expect(llm.requests).toHaveLength(2);

    // Another edit within 6 hours of that summary waits.
    advance(HOUR);
    setPr({ ...pr(1, "2026-11-24T20:00:00Z"), body: "And step 1c." });
    await job.run(ctx);
    expect(llm.requests).toHaveLength(2);

    advance(5 * HOUR);
    await job.run(ctx);
    expect(llm.requests).toHaveLength(3);
    expect(latestWorkstreamSummaries(db).size).toBe(1);
  });

  test("runs at most two calls per pass", async () => {
    const { ctx, setPr } = setup();
    for (const n of [1, 2, 3]) setPr(pr(n));
    const llm = new FakeLlmClient();
    const job = createWorkstreamSummariesJob({
      llm,
      workstreams: () => [workstream(1, [1]), workstream(2, [2]), workstream(3, [3])],
    });
    await job.run(ctx);
    expect(llm.requests).toHaveLength(2);
    await job.run(ctx);
    expect(llm.requests).toHaveLength(3);
  });

  test("over the daily cap, jobs wait and the last summary stays", async () => {
    const { db, ctx, setPr, advance } = setup({ llm: { dailyCapUsd: 0.001 } });
    setPr(pr(1));
    const llm = new FakeLlmClient(() => ({ name: "First", summary: "First summary." }));
    const job = createWorkstreamSummariesJob({ llm, workstreams: () => [workstream(1, [1])] });
    await job.run(ctx);
    expect(llm.requests).toHaveLength(1);

    advance(7 * HOUR);
    setPr({ ...pr(1, "2026-11-24T18:00:00Z"), title: "Renamed step" });
    llm.handler = () => ({ name: "Second", summary: "Second summary." });
    await job.run(ctx);
    expect(llm.requests).toHaveLength(1);
    expect(latestWorkstreamSummaries(db).get(`${REPO}:ws:1`)?.name).toBe("First");

    // Next UTC day
    advance(6 * HOUR);
    await job.run(ctx);
    expect(llm.requests).toHaveLength(2);
    expect(latestWorkstreamSummaries(db).get(`${REPO}:ws:1`)?.name).toBe("Second");
  });

  test("retries retryable failures with backoff and gives up after the attempt limit", async () => {
    const { db, ctx, setPr, advance } = setup();
    setPr(pr(1));
    const llm = new FakeLlmClient(() => {
      throw new LlmError("overloaded", 529, true);
    });
    const job = createWorkstreamSummariesJob({ llm, workstreams: () => [workstream(1, [1])] });
    await job.run(ctx);
    expect(llm.requests).toHaveLength(1);
    await job.run(ctx);
    expect(llm.requests).toHaveLength(1);

    for (let i = 1; i < LLM_MAX_ATTEMPTS + 2; i++) {
      advance(HOUR);
      // oxlint-disable-next-line no-await-in-loop -- each pass depends on the previous one
      await job.run(ctx);
    }
    expect(llm.requests).toHaveLength(LLM_MAX_ATTEMPTS);
    expect(latestWorkstreamSummaries(db).size).toBe(0);
  });

  test("invalid model output is retried, then accepted", async () => {
    const { db, ctx, setPr, advance } = setup();
    setPr(pr(1));
    let calls = 0;
    const llm = new FakeLlmClient(() => (++calls === 1 ? { summary: "no name" } : { name: "Ok", summary: "Fine." }));
    const job = createWorkstreamSummariesJob({ llm, workstreams: () => [workstream(1, [1])] });
    await job.run(ctx);
    advance(HOUR);
    await job.run(ctx);
    expect(llm.requests).toHaveLength(2);
    expect(latestWorkstreamSummaries(db).get(`${REPO}:ws:1`)?.name).toBe("Ok");
  });

  test("a member GitHub cannot return does not block the summary", async () => {
    const { ctx, gh, setPr, prs } = setup();
    setPr(pr(1));
    const llm = new FakeLlmClient();
    const job = createWorkstreamSummariesJob({ llm, workstreams: () => [workstream(1, [1, 9])] });
    expect(prs.has(9)).toBe(false);
    await job.run(ctx);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.user).toContain("(description not available)");
    await job.run(ctx);
    expect(gh.calls).toHaveLength(1);
  });

  test("by default summarizes the stored workstreams", async () => {
    const { db, ctx, setPr, clock } = setup();
    setPr(pr(1));
    setPr(pr(2));
    writeWorkstreams(db, REPO, [workstream(1, [1, 2])], new Set(), clock().toISOString());
    const llm = new FakeLlmClient();
    await createWorkstreamSummariesJob({ llm }).run(ctx);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.user).toContain("## #2 Step 2");
    expect(latestWorkstreamSummaries(db).has(`${REPO}:ws:1`)).toBe(true);
  });
});
