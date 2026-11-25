import { describe, expect, test } from "bun:test";
import { costUsd, utcDayStart } from "./cost.ts";
import { fnv1a64 } from "./hash.ts";
import { llmRetryDelayMs, prTextsToFetch, subjectNumber, SUMMARY_MIN_INTERVAL_MS, summaryDecision } from "./plan.ts";

const now = new Date("2026-11-24T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe("summaryDecision", () => {
  test("first summary queues right away", () => {
    expect(summaryDecision(null, "h1", now)).toBe("queue");
  });
  test("same hash is current", () => {
    expect(summaryDecision({ inputHash: "h1", createdAt: ago(60_000) }, "h1", now)).toBe("current");
  });
  test("changed hash waits out the 6 hour interval", () => {
    expect(summaryDecision({ inputHash: "h1", createdAt: ago(60_000) }, "h2", now)).toBe("wait");
    expect(summaryDecision({ inputHash: "h1", createdAt: ago(SUMMARY_MIN_INTERVAL_MS) }, "h2", now)).toBe("queue");
  });
});

describe("prTextsToFetch", () => {
  const stored = new Map([
    [1, { updatedAt: "2026-11-24T10:00:00Z" }],
    [2, { updatedAt: "2026-11-24T10:00:00Z" }],
    [3, { updatedAt: "2026-11-24T10:00:00Z" }],
  ]);
  const listed = new Map([
    [1, { updatedAt: "2026-11-24T10:00:00Z" }],
    [2, { updatedAt: "2026-11-24T11:00:00Z" }],
  ]);
  test("fetches unstored and updated members only", () => {
    expect(prTextsToFetch([1, 2, 3, 4], stored, listed)).toEqual([2, 4]);
  });
});

test("llmRetryDelayMs grows 1, 4, 16 minutes", () => {
  expect([1, 2, 3].map(llmRetryDelayMs)).toEqual([60_000, 240_000, 960_000]);
});

test("subjectNumber", () => {
  expect(subjectNumber("acme/app#42")).toBe(42);
  expect(subjectNumber("acme/app")).toBeNull();
  expect(subjectNumber("acme/app#x")).toBeNull();
});

describe("costUsd", () => {
  const prices = { m: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };
  test("prices each token kind per million", () => {
    const usage = { input: 2_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 400_000 };
    expect(costUsd(usage, "m", prices)).toBeCloseTo(2 + 0.5 + 0.1 + 0.5, 10);
  });
  test("unknown model has no price", () => {
    expect(costUsd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, "other", prices)).toBeNull();
  });
});

test("utcDayStart", () => {
  expect(utcDayStart(new Date("2026-11-24T23:59:59.999Z"))).toBe("2026-11-24T00:00:00.000Z");
});

test("fnv1a64 is stable 16 hex digits", () => {
  expect(fnv1a64("")).toBe("cbf29ce484222325");
  expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  expect(fnv1a64("é")).not.toBe(fnv1a64("e"));
});
