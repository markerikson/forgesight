import { describe, expect, test } from "bun:test";
import {
  claimLlmJobs,
  completeLlmJob,
  enqueueLlmJob,
  failLlmJob,
  getLlmJob,
  lastLlmJobFor,
  latestSummary,
  latestWorkstreamSummaries,
  llmSpendSince,
  recordLlmCall,
  requeueStaleLlmJobs,
  saveSummary,
  type SummaryRecord,
} from "./llm.ts";
import { memoryDb } from "./test-db.ts";

const T0 = "2026-11-24T12:00:00.000Z";
const T1 = "2026-11-24T12:05:00.000Z";
const T2 = "2026-11-24T12:10:00.000Z";

const job = (subjectKey: string, inputHash: string) => ({
  kind: "workstream" as const,
  subjectKey,
  inputHash,
  requestJson: "{}",
});

function summary(subjectKey: string, inputHash: string, createdAt: string, extra: Partial<SummaryRecord> = {}): SummaryRecord {
  return {
    kind: "workstream",
    subjectKey,
    inputHash,
    promptVersion: 1,
    model: "claude-haiku-4-5",
    name: `Name ${inputHash}`,
    text: `Text ${inputHash}`,
    status: null,
    outputJson: "{}",
    costUsd: 0.004,
    createdAt,
    ...extra,
  };
}

describe("llm jobs", () => {
  test("enqueue reuses a live job for the same input and supersedes other inputs", () => {
    const db = memoryDb();
    const a = enqueueLlmJob(db, job("ws1", "h1"), T0);
    expect(enqueueLlmJob(db, job("ws1", "h1"), T1)).toBe(a);
    const b = enqueueLlmJob(db, job("ws1", "h2"), T1);
    expect(b).not.toBe(a);
    expect(getLlmJob(db, a)?.status).toBe("superseded");
    expect(getLlmJob(db, b)?.status).toBe("queued");
    expect(enqueueLlmJob(db, job("ws2", "h1"), T1)).not.toBe(a);
  });

  test("claim takes ready jobs up to the limit and counts attempts", () => {
    const db = memoryDb();
    const ids = ["ws1", "ws2", "ws3"].map((k) => enqueueLlmJob(db, job(k, "h"), T0));
    const claimed = claimLlmJobs(db, T1, 2);
    expect(claimed.map((j) => j.id)).toEqual(ids.slice(0, 2));
    expect(claimed.every((j) => j.status === "running" && j.attempts === 1 && j.startedAt === T1)).toBe(true);
    expect(claimLlmJobs(db, T1, 2).map((j) => j.id)).toEqual([ids[2]!]);
    expect(claimLlmJobs(db, T1, 2)).toEqual([]);
  });

  test("complete, retry later, fail for good", () => {
    const db = memoryDb();
    const id = enqueueLlmJob(db, job("ws1", "h"), T0);
    claimLlmJobs(db, T0, 1);
    failLlmJob(db, id, "overloaded", T0, T2);
    expect(getLlmJob(db, id)).toMatchObject({ status: "queued", error: "overloaded", runAfter: T2 });
    expect(claimLlmJobs(db, T1, 1)).toEqual([]);
    expect(claimLlmJobs(db, T2, 1)[0]?.attempts).toBe(2);
    failLlmJob(db, id, "bad request", T2, null);
    expect(getLlmJob(db, id)).toMatchObject({ status: "failed", finishedAt: T2 });
    expect(lastLlmJobFor(db, "workstream", "ws1", "h")?.status).toBe("failed");

    const other = enqueueLlmJob(db, job("ws2", "h"), T0);
    claimLlmJobs(db, T0, 1);
    completeLlmJob(db, other, T1);
    expect(getLlmJob(db, other)).toMatchObject({ status: "done", finishedAt: T1 });
  });

  test("stale running jobs go back to the queue", () => {
    const db = memoryDb();
    const id = enqueueLlmJob(db, job("ws1", "h"), T0);
    claimLlmJobs(db, T0, 1);
    expect(requeueStaleLlmJobs(db, T0)).toBe(0);
    expect(requeueStaleLlmJobs(db, T1)).toBe(1);
    expect(getLlmJob(db, id)?.status).toBe("queued");
  });
});

describe("llm calls", () => {
  test("spend sums cost since a time", () => {
    const db = memoryDb();
    const call = (costUsd: number, createdAt: string) =>
      recordLlmCall(db, {
        jobId: null,
        kind: "workstream",
        model: "m",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        costUsd,
        durationMs: 10,
        ok: true,
        error: null,
        createdAt,
      });
    call(0.5, "2026-11-23T23:59:59.000Z");
    call(0.25, T0);
    call(0.125, T1);
    expect(llmSpendSince(db, "2026-11-24T00:00:00.000Z")).toBeCloseTo(0.375, 10);
    expect(llmSpendSince(db, "2026-11-25T00:00:00.000Z")).toBe(0);
  });
});

describe("summaries", () => {
  test("latest summary per workstream", () => {
    const db = memoryDb();
    saveSummary(db, summary("ws1", "h1", T0));
    saveSummary(db, summary("ws1", "h2", T2, { status: "Merged" }));
    saveSummary(db, summary("ws2", "h1", T1));
    expect(latestSummary(db, "workstream", "ws1")?.inputHash).toBe("h2");

    const all = latestWorkstreamSummaries(db);
    expect(all.size).toBe(2);
    expect(all.get("ws1")).toEqual({ name: "Name h2", text: "Text h2", status: "Merged", generatedAt: T2, inputHash: "h2" });
    expect([...latestWorkstreamSummaries(db, ["ws2", "ws9"]).keys()]).toEqual(["ws2"]);
    expect(latestWorkstreamSummaries(db, []).size).toBe(0);
  });

  test("saving the same input again replaces the row", () => {
    const db = memoryDb();
    saveSummary(db, summary("ws1", "h1", T0));
    saveSummary(db, summary("ws1", "h1", T1, { text: "again" }));
    expect(latestSummary(db, "workstream", "ws1")).toMatchObject({ text: "again", createdAt: T1 });
  });
});
