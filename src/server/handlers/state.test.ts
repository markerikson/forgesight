import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { META } from "../../core/meta-keys.ts";
import { getItemState } from "../../store/item-state.ts";
import { getMeta } from "../../store/meta.ts";
import { ensureSubjects } from "../../store/subjects.ts";
import { upsertThreads } from "../../store/threads.ts";
import { getView } from "../../store/views.ts";
import { originGuard } from "../guards.ts";
import { testCtx } from "../test-ctx.ts";
import {
  MAX_KEYS,
  refreshHandler,
  stateHandler,
  type StateResponse,
  undoHandler,
  type UndoResponse,
} from "./state.ts";

const NOW = new Date("2026-11-23T12:00:00Z");

function key(n: number): string {
  return `octo/repo#${n}`;
}

function seed(db: Database, count: number, reason = "review_requested"): string[] {
  const keys = Array.from({ length: count }, (_, i) => key(i + 1));
  ensureSubjects(
    db,
    keys.map((subjectKey, i) => ({
      subjectKey,
      repo: "octo/repo",
      number: i + 1,
      kind: "pr" as const,
      origin: "thread" as const,
    })),
  );
  upsertThreads(
    db,
    keys.map((subjectKey, i) => ({
      threadId: `T${i + 1}`,
      subjectKey,
      repo: "octo/repo",
      subjectType: "PullRequest",
      reason,
      unread: true,
      updatedAt: "2026-11-23T10:00:00Z",
      lastReadAt: null,
      subjectUrl: null,
      raw: { subject: { title: `PR ${i + 1}` } },
    })),
    NOW.toISOString(),
  );
  return keys;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost:7777${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("stateHandler", () => {
  test.each([
    ["not json", "{"],
    ["no keys", { op: { kind: "done" } }],
    ["empty keys", { keys: [], op: { kind: "done" } }],
    ["too many keys", { keys: Array.from({ length: MAX_KEYS + 1 }, (_, i) => key(i)), op: { kind: "done" } }],
    ["non-string key", { keys: [5], op: { kind: "done" } }],
    ["unknown op", { keys: [key(1)], op: { kind: "explode" } }],
    ["bad snooze", { keys: [key(1)], op: { kind: "snooze", until: "soon" } }],
  ])("rejects %s with 400", async (_name, body) => {
    const ctx = testCtx(NOW);
    seed(ctx.db, 1);
    const res = await stateHandler(post("/api/state", body), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  test("returns 404 with the unknown keys and writes nothing", async () => {
    const ctx = testCtx(NOW);
    seed(ctx.db, 1);
    const res = await stateHandler(
      post("/api/state", { keys: [key(1), "nope/x#1"], op: { kind: "done" } }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", keys: ["nope/x#1"] });
    expect(getItemState(ctx.db, key(1))?.doneAt ?? null).toBeNull();
  });

  test("applies the op, queues GitHub writes and returns fresh rows", async () => {
    const ctx = testCtx(NOW);
    seed(ctx.db, 2);
    const res = await stateHandler(
      post("/api/state", { keys: [key(1), key(2)], op: { kind: "done" } }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateResponse;
    expect(body.opId).toBeGreaterThan(0);
    expect(body.outboxIds).toHaveLength(2);
    expect(Object.keys(body.rows).sort()).toEqual([key(1), key(2)]);
    expect(getItemState(ctx.db, key(1))?.doneAt).toBe(NOW.toISOString());
    expect(body.rows[key(1)]).toEqual(getView(ctx.db, key(1))?.row as never);
  });

  test("Done on a muted Hidden subject queues the GitHub write", async () => {
    const ctx = testCtx(NOW);
    seed(ctx.db, 1, "subscribed");
    const muted = (await (
      await stateHandler(post("/api/state", { keys: [key(1)], op: { kind: "mute" } }), ctx)
    ).json()) as StateResponse;
    expect(muted.rows[key(1)]?.section).toBe("hidden");

    const res = await stateHandler(post("/api/state", { keys: [key(1)], op: { kind: "done" } }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateResponse;
    expect(body.outboxIds).toHaveLength(1);
    const queued = ctx.db.query<{ thread_id: string; op: string }, []>("SELECT thread_id, op FROM outbox").all();
    expect(queued).toEqual([{ thread_id: "T1", op: "done" }]);
    expect(body.rows[key(1)]).toMatchObject({ section: "hidden", unread: false });
  });

  test("200-key Done is one op that one undo restores", async () => {
    const ctx = testCtx(NOW);
    const keys = seed(ctx.db, 200);
    const res = await stateHandler(post("/api/state", { keys, op: { kind: "done" } }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateResponse;
    expect(Object.keys(body.rows)).toHaveLength(200);
    const ops = ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM state_ops").get();
    expect(ops?.n).toBe(1);

    const undo = await undoHandler(post("/api/state/undo", { opId: body.opId }), ctx);
    expect(undo.status).toBe(200);
    const undone = (await undo.json()) as UndoResponse;
    expect(undone.result).toBe("undone");
    if (undone.result !== "undone") return;
    expect(undone.githubApplied).toBe(0);
    expect(Object.keys(undone.rows)).toHaveLength(200);
    for (const k of keys) expect(getItemState(ctx.db, k)?.doneAt ?? null).toBeNull();
    const pending = ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outbox").get();
    expect(pending?.n).toBe(0);
  });
});

describe("undoHandler", () => {
  test("rejects a bad opId with 400", async () => {
    const res = await undoHandler(post("/api/state/undo", { opId: "1" }), testCtx(NOW));
    expect(res.status).toBe(400);
  });

  test("returns 404 for an unknown op", async () => {
    const res = await undoHandler(post("/api/state/undo", { opId: 99 }), testCtx(NOW));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ result: "notFound" });
  });

  test("returns 409 when a later op touched the same key, or when already undone", async () => {
    const ctx = testCtx(NOW);
    seed(ctx.db, 1);
    const first = (await (
      await stateHandler(post("/api/state", { keys: [key(1)], op: { kind: "read" } }), ctx)
    ).json()) as StateResponse;
    const second = (await (
      await stateHandler(post("/api/state", { keys: [key(1)], op: { kind: "done" } }), ctx)
    ).json()) as StateResponse;

    const superseded = await undoHandler(post("/api/state/undo", { opId: first.opId }), ctx);
    expect(superseded.status).toBe(409);
    expect(await superseded.json()).toEqual({ result: "superseded" });

    expect((await undoHandler(post("/api/state/undo", { opId: second.opId }), ctx)).status).toBe(200);
    const again = await undoHandler(post("/api/state/undo", { opId: second.opId }), ctx);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ result: "alreadyUndone" });
  });
});

describe("refreshHandler", () => {
  test("records the poll request and returns 202", async () => {
    const ctx = testCtx(NOW);
    const res = await refreshHandler(post("/api/refresh", {}), ctx);
    expect(res.status).toBe(202);
    expect(getMeta(ctx.db, META.pollRequestedAt)).toBe(NOW.toISOString());
  });
});

test("the guard rejects a cross-origin POST", () => {
  const req = new Request("http://localhost:7777/api/state", {
    method: "POST",
    headers: { host: "localhost:7777", origin: "https://evil.example" },
  });
  expect(originGuard(req)?.status).toBe(403);
});
