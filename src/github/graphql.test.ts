import { describe, expect, test } from "bun:test";
import { GqlError, RateLimitedError } from "./errors.ts";
import { type FetchFn, MAX_ATTEMPTS, createGraphqlRunner } from "./graphql.ts";
import type { ApiCallRecord } from "./types.ts";

const now = new Date("2026-11-23T12:00:00Z");
const opts = { repo: "reduxjs/redux-toolkit", workClass: "enrich" } as const;
const rateLimit = { cost: 3, remaining: 4990, resetAt: "2026-11-23T12:45:00Z" };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function setup(responses: Array<Response | Error>) {
  const calls: ApiCallRecord[] = [];
  const sleeps: number[] = [];
  let requests = 0;
  const fetch: FetchFn = async () => {
    const next = responses[requests++];
    if (!next) throw new Error("no more stubbed responses");
    if (next instanceof Error) throw next;
    return next;
  };
  const run = createGraphqlRunner({
    token: "t",
    fetch,
    clock: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onCall: (call) => calls.push(call),
  });
  return { run, calls, sleeps, requests: () => requests };
}

describe("createGraphqlRunner", () => {
  test("returns data with the rateLimit field removed and records the cost", async () => {
    const { run, calls } = setup([json(200, { data: { repository: { id: "R1" }, rateLimit } })]);
    const result = await run<{ repository: { id: string } }>("query", {}, opts);
    expect(result.data).toEqual({ repository: { id: "R1" } });
    expect(result.cost).toBe(3);
    expect(result.remaining).toBe(4990);
    expect(result.resetAt).toEqual(new Date(rateLimit.resetAt));
    expect(result.errors).toBeUndefined();
    expect(result.gatewayErrors).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ resource: "graphql", workClass: "enrich", status: 200, cost: 3, remaining: 4990 });
  });

  test("retries a 502, then succeeds and reports the gateway error", async () => {
    const { run, calls, sleeps } = setup([
      new Response("bad gateway", { status: 502 }),
      json(200, { data: { viewer: { login: "markerikson" }, rateLimit } }),
    ]);
    const result = await run<{ viewer: { login: string } }>("query", {}, opts);
    expect(result.data.viewer.login).toBe("markerikson");
    expect(result.gatewayErrors).toBe(1);
    expect(sleeps).toEqual([2000]);
    expect(calls.map((c) => c.status)).toEqual([502, 200]);
  });

  test("throws a gateway GqlError after repeated 502s", async () => {
    const { run, sleeps, requests } = setup(
      Array.from({ length: MAX_ATTEMPTS }, () => new Response("bad gateway", { status: 502 })),
    );
    const error = await run("query", {}, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GqlError);
    expect(error).toMatchObject({ kind: "gateway", status: 502 });
    expect(requests()).toBe(MAX_ATTEMPTS);
    expect(sleeps).toEqual([2000, 4000, 8000]);
  });

  test("retries network errors", async () => {
    const { run, calls } = setup([new TypeError("ECONNRESET"), json(200, { data: { rateLimit } })]);
    await run("query", {}, opts);
    expect(calls.map((c) => c.status)).toEqual([0, 200]);
  });

  test("returns partial data together with errors", async () => {
    const errors = [
      { type: "NOT_FOUND", path: ["pr2"], message: "Could not resolve to a PullRequest with the number of 2." },
    ];
    const { run } = setup([json(200, { data: { pr1: { number: 1 }, pr2: null, rateLimit }, errors })]);
    const result = await run<{ pr1: { number: number } | null; pr2: null }>("query", {}, opts);
    expect(result.data).toEqual({ pr1: { number: 1 }, pr2: null });
    expect(result.errors).toEqual(errors);
    expect(result.cost).toBe(3);
  });

  test("throws a GqlError when errors come without data", async () => {
    const { run } = setup([json(200, { errors: [{ message: "Field 'nope' doesn't exist on type 'Query'" }] })]);
    const error = await run("query", {}, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GqlError);
    expect(error).toMatchObject({ kind: "graphql" });
  });

  test("throws a secondary RateLimitedError, pausing at least 60s", async () => {
    const { run, requests } = setup([
      json(403, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "30" }),
    ]);
    const error = await run("query", {}, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ secondary: true, resetAt: new Date(now.getTime() + 60_000) });
    expect(requests()).toBe(1);
  });

  test("uses retry-after when it is longer than 60s", async () => {
    const { run } = setup([json(429, { message: "slow down" }, { "retry-after": "120" })]);
    const error = await run("query", {}, opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ secondary: true, resetAt: new Date(now.getTime() + 120_000) });
  });

  test("detects a secondary limit from the message without retry-after", async () => {
    const { run } = setup([json(403, { message: "You have exceeded a secondary rate limit" })]);
    const error = await run("query", {}, opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ secondary: true });
  });

  test("throws a primary RateLimitedError for RATE_LIMITED", async () => {
    const { run } = setup([
      json(
        200,
        { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000" },
      ),
    ]);
    const error = await run("query", {}, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ secondary: false, resetAt: new Date(1795000000 * 1000) });
  });
});
