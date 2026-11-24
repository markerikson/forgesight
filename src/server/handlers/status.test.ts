import { describe, expect, test } from "bun:test";
import { parseConfigText } from "../../config/load.ts";
import { recordApiCall } from "../../store/api-calls.ts";
import { setMeta } from "../../store/meta.ts";
import { ensureSubjects, markDirty } from "../../store/subjects.ts";
import { memoryDb } from "../../store/test-db.ts";
import type { ServerCtx } from "../ctx.ts";
import { type StatusPayload, statusHandler } from "./status.ts";

const NOW = new Date("2026-11-23T12:00:00.000Z");

function ctx(): ServerCtx {
  return { db: memoryDb(), config: parseConfigText("{}"), configError: null, now: () => NOW };
}

async function status(c: ServerCtx): Promise<StatusPayload> {
  const res = await statusHandler(new Request("http://127.0.0.1:4630/api/status"), c);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusPayload;
}

function call(at: string, resource: string, workClass: string, status: number, cost: number | null) {
  return { at, resource, workClass, request: "x", status, cost, remaining: null, resetAt: null, durationMs: 5 };
}

describe("statusHandler", () => {
  test("reports nulls on a fresh database", async () => {
    const s = await status(ctx());
    expect(s.now).toBe(NOW.toISOString());
    expect(s.worker).toEqual({ status: null, heartbeatAt: null, alive: null, authFailed: false });
    expect(s.viewer.login).toBeNull();
    expect(s.poll.lastPollStartedAt).toBeNull();
    expect(s.backfill.inProgress).toBe(false);
    expect(s.enrichQueue).toEqual({ pending: 0, failing: 0 });
    expect(s.spend).toEqual({ since: "2026-11-23T11:00:00.000Z", graphql: 0, rest: 0, byClass: [] });
    expect(s.configError).toBeNull();
  });

  test("reads worker meta and heartbeat freshness", async () => {
    const c = ctx();
    const at = "2026-11-23T11:59:00.000Z";
    setMeta(c.db, "worker.status", "running", at);
    setMeta(c.db, "worker.heartbeatAt", "2026-11-23T11:59:50.000Z", at);
    setMeta(c.db, "viewer.login", "markerikson", at);
    setMeta(c.db, "notifications.lastPollStartedAt", at, at);
    setMeta(c.db, "backfill.startedAt", at, at);
    const s = await status(c);
    expect(s.worker).toEqual({
      status: "running",
      heartbeatAt: "2026-11-23T11:59:50.000Z",
      alive: true,
      authFailed: false,
    });
    expect(s.viewer.login).toBe("markerikson");
    expect(s.poll.lastPollStartedAt).toBe(at);
    expect(s.backfill.inProgress).toBe(true);
  });

  test("flags a stale heartbeat and auth failure", async () => {
    const c = ctx();
    setMeta(c.db, "worker.status", "auth_failed", NOW.toISOString());
    setMeta(c.db, "worker.heartbeatAt", "2026-11-23T11:50:00.000Z", NOW.toISOString());
    const s = await status(c);
    expect(s.worker.alive).toBe(false);
    expect(s.worker.authFailed).toBe(true);
  });

  test("sums API spend over the last hour only", async () => {
    const c = ctx();
    recordApiCall(c.db, call("2026-11-23T11:30:00.000Z", "graphql", "enrich", 200, 3));
    recordApiCall(c.db, call("2026-11-23T11:40:00.000Z", "graphql", "enrich", 200, 2));
    recordApiCall(c.db, call("2026-11-23T11:45:00.000Z", "rest", "notifications", 200, null));
    recordApiCall(c.db, call("2026-11-23T11:46:00.000Z", "rest", "notifications", 304, null));
    recordApiCall(c.db, call("2026-11-23T10:00:00.000Z", "graphql", "enrich", 200, 50));
    const s = await status(c);
    expect(s.spend.graphql).toBe(5);
    expect(s.spend.rest).toBe(1);
    expect(s.spend.byClass.find((r) => r.resource === "graphql")).toMatchObject({ workClass: "enrich", calls: 2 });
  });

  test("counts subjects waiting for enrichment", async () => {
    const c = ctx();
    ensureSubjects(c.db, [
      { subjectKey: "o/r#1", repo: "o/r", number: 1, kind: "pr", origin: "thread" },
      { subjectKey: "o/r#2", repo: "o/r", number: 2, kind: "issue", origin: "thread" },
    ]);
    markDirty(c.db, ["o/r#1"], NOW.toISOString());
    const s = await status(c);
    expect(s.enrichQueue.pending).toBe(1);
  });

  test("passes the config error through", async () => {
    const s = await status({ ...ctx(), configError: "bad yaml" });
    expect(s.configError).toBe("bad yaml");
  });
});
