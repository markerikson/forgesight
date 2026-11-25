import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../../config/load.ts";
import { openPullsMetaKey } from "../../core/meta-keys.ts";
import type { OpenPull, OpenPullsListing } from "../../github/queries/open-pulls.ts";
import { setMeta } from "../../store/meta.ts";
import { getWorkstream, getWorkstreamState } from "../../store/workstreams.ts";
import { rebuildWorkstreams } from "../../worker/workstreams.ts";
import { testCtx } from "../test-ctx.ts";
import { undoHandler, type UndoResponse } from "./state.ts";
import {
  workstreamsHandler,
  type WorkstreamsResponse,
  workstreamStateHandler,
  type WorkstreamStateResponse,
} from "./workstreams.ts";

const NOW = new Date("2026-11-24T12:00:00Z");
const REPO = "octo/stack";
const k = (n: number) => `${REPO}#${n}`;
const A = `${REPO}:ws:10`;
const B = `${REPO}:ws:20`;

function pull(number: number, base: string): OpenPull {
  return {
    number,
    title: `PR ${number}`,
    author: "alice",
    authorType: "User",
    headRef: `b${number}`,
    baseRef: base,
    headSha: `sha${number}`,
    updatedAt: "2026-11-24T10:00:00Z",
    isDraft: false,
  };
}

function setup() {
  const config = resolveConfig({ me: "mark", repos: { [REPO]: { view: "overview" } } });
  const ctx = testCtx(NOW, { config });
  const listing: OpenPullsListing = {
    repo: REPO,
    fetchedAt: NOW.toISOString(),
    pulls: [pull(10, "main"), pull(11, "b10"), pull(20, "main"), pull(21, "b20")],
  };
  setMeta(ctx.db, openPullsMetaKey(REPO), JSON.stringify(listing), NOW.toISOString());
  rebuildWorkstreams(ctx.db, config, REPO, NOW);
  return ctx;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost:7777${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const call = (ctx: ReturnType<typeof setup>, body: unknown) =>
  workstreamStateHandler(post("/api/workstreams/state", body), ctx);

describe("workstreamStateHandler", () => {
  test.each([
    ["not json", "{"],
    ["no id", { op: { kind: "unsnooze" } }],
    ["bad op", { id: A, op: { kind: "setPriority", priority: "urgent" } }],
    ["merge into itself", { id: A, op: { kind: "merge", from: A } }],
    ["merge unknown", { id: A, op: { kind: "merge", from: "nope" } }],
    ["remove non-member", { id: A, op: { kind: "remove", key: k(20) } }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await call(setup(), body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  test("returns 404 for an unknown workstream", async () => {
    const res = await call(setup(), { id: "nope", op: { kind: "unsnooze" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", ids: ["nope"] });
  });

  test("setPriority returns the workstream snapshot and undo restores it", async () => {
    const ctx = setup();
    const res = await call(ctx, { id: A, op: { kind: "setPriority", priority: "muted" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkstreamStateResponse;
    expect(body.workstreams[A]?.state.priority).toBe("muted");
    expect(body.rows).toEqual({});

    const undo = await undoHandler(post("/api/state/undo", { opId: body.opId }), ctx);
    expect(undo.status).toBe(200);
    const undone = (await undo.json()) as UndoResponse;
    expect(undone.result).toBe("undone");
    expect(getWorkstreamState(ctx.db, A).priority).toBe("normal");
  });

  test("merge rebuilds the repo, re-derives members, and undo splits it again", async () => {
    const ctx = setup();
    const res = await call(ctx, { id: A, op: { kind: "merge", from: B } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkstreamStateResponse;
    expect(body.workstreams[A]?.members.map((m) => m.key)).toEqual([k(10), k(11), k(20), k(21)]);
    expect(body.workstreams[B]).toBeNull();
    expect(Object.keys(body.rows).sort()).toEqual([k(10), k(11), k(20), k(21)]);
    expect(body.rows[k(20)]).toBeDefined();

    const undo = await undoHandler(post("/api/state/undo", { opId: body.opId }), ctx);
    const undone = (await undo.json()) as UndoResponse;
    expect(undone.result).toBe("undone");
    if (undone.result !== "undone") return;
    expect(undone.workstreams?.[B]?.members.map((m) => m.key)).toEqual([k(20), k(21)]);
    expect(getWorkstream(ctx.db, A)?.members.map((m) => m.key)).toEqual([k(10), k(11)]);
  });

  test("merging into the higher-numbered workstream keeps the target's ID and state", async () => {
    const ctx = setup();
    await call(ctx, { id: B, op: { kind: "setPriority", priority: "low" } });
    const res = await call(ctx, { id: B, op: { kind: "merge", from: A } });
    const body = (await res.json()) as WorkstreamStateResponse;
    expect(body.workstreams[B]?.members.map((m) => m.key)).toEqual([k(10), k(11), k(20), k(21)]);
    expect(body.workstreams[B]?.state.priority).toBe("low");
    expect(body.workstreams[A]).toBeNull();

    const undo = await undoHandler(post("/api/state/undo", { opId: body.opId }), ctx);
    const undone = (await undo.json()) as UndoResponse;
    if (undone.result !== "undone") throw new Error(undone.result);
    expect(undone.workstreams?.[A]?.members.map((m) => m.key)).toEqual([k(10), k(11)]);
    expect(undone.workstreams?.[B]?.members.map((m) => m.key)).toEqual([k(20), k(21)]);
    expect(undone.workstreams?.[B]?.state.priority).toBe("low");
  });

  test("undoing a merge brings back the absorbed workstream's manual name", async () => {
    const ctx = setup();
    await call(ctx, { id: B, op: { kind: "rename", name: "Billing" } });
    const res = await call(ctx, { id: A, op: { kind: "merge", from: B } });
    const body = (await res.json()) as WorkstreamStateResponse;
    expect(body.workstreams[B]).toBeNull();

    const undo = await undoHandler(post("/api/state/undo", { opId: body.opId }), ctx);
    const undone = (await undo.json()) as UndoResponse;
    if (undone.result !== "undone") throw new Error(undone.result);
    expect(undone.workstreams?.[B]?.name).toBe("Billing");
  });

  test("rename sets the displayed name", async () => {
    const ctx = setup();
    const res = await call(ctx, { id: A, op: { kind: "rename", name: "Auth rework" } });
    const body = (await res.json()) as WorkstreamStateResponse;
    expect(body.workstreams[A]?.name).toBe("Auth rework");
  });
});

describe("workstreamsHandler", () => {
  test("lists workstreams with state, filtered by repo", async () => {
    const ctx = setup();
    const all = (await (
      await workstreamsHandler(new Request("http://localhost:7777/api/workstreams"), ctx)
    ).json()) as WorkstreamsResponse;
    expect(all.workstreams.map((w) => w.id)).toEqual([A, B]);
    expect(all.workstreams[0]?.state.priority).toBe("normal");
    const none = (await (
      await workstreamsHandler(new Request("http://localhost:7777/api/workstreams?repo=x/y"), ctx)
    ).json()) as WorkstreamsResponse;
    expect(none.workstreams).toEqual([]);
  });
});
