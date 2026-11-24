import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import { META } from "../core/meta-keys.ts";
import { Governor, MemoryApiCallLog } from "../github/budget.ts";
import { FakeGitHubClient } from "../github/fake.ts";
import { recordApiCall } from "../store/api-calls.ts";
import { getMeta } from "../store/meta.ts";
import { memoryDb } from "../store/test-db.ts";
import { appendChange, changesAfter } from "../store/views.ts";
import { maintenanceJob, runMaintenance } from "./maintenance.ts";
import type { JobContext, Logger } from "./scheduler.ts";

const NOW = new Date("2026-11-23T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const quietLog: Logger = { info() {}, warn() {}, error() {} };

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function apiCall(at: string) {
  return { at, resource: "rest", workClass: "notifications", request: "x", status: 200, cost: null, remaining: null, resetAt: null, durationMs: 1 };
}

function insertOp(db: ReturnType<typeof memoryDb>, at: string, outbox: "completed" | "failed" | null): void {
  const opId = Number(
    db.query("INSERT INTO state_ops (created_at, op_json, prev_json) VALUES (?, '{}', '{}')").run(at)
      .lastInsertRowid,
  );
  if (!outbox) return;
  db.query(
    `INSERT INTO outbox (state_op_id, op, thread_id, subject_key, created_at, run_after, completed_at, failed_at)
     VALUES (?, 'done', 'T1', 'o/r#1', ?, ?, ?, ?)`,
  ).run(opId, at, at, outbox === "completed" ? at : null, outbox === "failed" ? at : null);
}

function count(db: ReturnType<typeof memoryDb>, table: "state_ops" | "outbox" | "api_calls"): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
}

describe("runMaintenance", () => {
  test("prunes by age and keeps failed outbox rows", () => {
    const db = memoryDb();
    appendChange(db, "view", "o/r#1", daysAgo(8));
    appendChange(db, "view", "o/r#1", daysAgo(6));
    recordApiCall(db, apiCall(daysAgo(31)));
    recordApiCall(db, apiCall(daysAgo(29)));
    insertOp(db, daysAgo(31), "completed");
    insertOp(db, daysAgo(31), "failed");
    insertOp(db, daysAgo(31), null);
    insertOp(db, daysAgo(29), "completed");

    const summary = runMaintenance(db, NOW);
    expect(summary).toEqual({ changes: 1, apiCalls: 1, outbox: 1, stateOps: 2 });
    expect(changesAfter(db, 0)).toHaveLength(1);
    expect(count(db, "api_calls")).toBe(1);
    expect(count(db, "state_ops")).toBe(2);
    expect(count(db, "outbox")).toBe(2);
    expect(getMeta(db, META.maintenanceAt)).toBe(NOW.toISOString());
  });
});

describe("maintenanceJob", () => {
  test("runs at most once an hour", async () => {
    const db = memoryDb();
    let now = NOW;
    const clock = () => now;
    const config = resolveConfig({});
    const ctx: JobContext = {
      db,
      gh: new FakeGitHubClient(clock),
      governor: new Governor(new MemoryApiCallLog(), config.budget, clock),
      config,
      clock,
      log: quietLog,
    };
    expect(await maintenanceJob.run(ctx)).toBe("idle");
    expect(getMeta(db, META.maintenanceAt)).toBe(NOW.toISOString());

    now = new Date(NOW.getTime() + 59 * 60_000);
    await maintenanceJob.run(ctx);
    expect(getMeta(db, META.maintenanceAt)).toBe(NOW.toISOString());

    now = new Date(NOW.getTime() + 60 * 60_000);
    await maintenanceJob.run(ctx);
    expect(getMeta(db, META.maintenanceAt)).toBe(now.toISOString());
  });
});
