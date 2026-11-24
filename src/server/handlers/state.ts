import type { Database } from "bun:sqlite";
import type { InboxRow, SubjectKey } from "../../core/index.ts";
import { META } from "../../core/meta-keys.ts";
import { isValidStateOp, type StateOp } from "../../core/state.ts";
import { getMeta, setMeta } from "../../store/meta.ts";
import { applyStateOps, undoStateOp } from "../../store/state-ops.ts";
import { getSubject } from "../../store/subjects.ts";
import { getView } from "../../store/views.ts";
import { deriveKeys } from "../../worker/derive.ts";
import type { ServerCtx } from "../ctx.ts";

export const MAX_KEYS = 200;

export interface StateRequest {
  keys: SubjectKey[];
  op: StateOp;
}

export interface StateResponse {
  opId: number;
  outboxIds: number[];
  rows: Record<SubjectKey, InboxRow>;
}

export type UndoResponse =
  | { result: "undone"; githubApplied: number; rows: Record<SubjectKey, InboxRow> }
  | { result: "superseded" | "alreadyUndone" | "notFound" };

function badRequest(message: string): Response {
  return Response.json({ error: "bad_request", message }, { status: 400 });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function parseStateRequest(body: unknown): StateRequest | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { keys, op } = body as Record<string, unknown>;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) {
    return `keys must be an array of 1-${MAX_KEYS} subject keys`;
  }
  if (!keys.every((k) => typeof k === "string" && k.length > 0)) return "keys must be strings";
  if (!isValidStateOp(op)) return "op is not a valid state op";
  return { keys: [...new Set(keys as string[])], op };
}

/**
 * Derives `keys` right away on the write connection so the response, and any inbox refetch
 * an SSE event triggers, already shows the new state. Uses the worker's `me` fallback so the
 * stored config hash matches the worker's.
 */
function deriveNow(ctx: ServerCtx, db: Database, keys: SubjectKey[]): Record<SubjectKey, InboxRow> {
  const config = ctx.config.me
    ? ctx.config
    : { ...ctx.config, me: getMeta(db, META.viewerLogin) ?? null };
  deriveKeys(db, keys, config, ctx.now());
  const rows: Record<SubjectKey, InboxRow> = {};
  for (const key of keys) {
    const view = getView(db, key);
    if (view) rows[key] = view.row as unknown as InboxRow;
  }
  return rows;
}

export async function stateHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const parsed = parseStateRequest(await readJson(req));
  if (typeof parsed === "string") return badRequest(parsed);
  const db = ctx.writeDb();
  const unknown = parsed.keys.filter((k) => !getSubject(db, k));
  if (unknown.length > 0) {
    return Response.json({ error: "not_found", keys: unknown }, { status: 404 });
  }
  const { opId, outboxIds } = applyStateOps(db, parsed.keys, parsed.op, ctx.now().toISOString());
  const body: StateResponse = { opId, outboxIds, rows: deriveNow(ctx, db, parsed.keys) };
  return Response.json(body);
}

/** Subject keys an op touched: the keys of its stored previous states. */
function opKeys(db: Database, opId: number): SubjectKey[] {
  const row = db
    .query<{ key: string }, [number]>(
      "SELECT e.key AS key FROM state_ops s, json_each(s.prev_json) e WHERE s.id = ?",
    )
    .all(opId);
  return row.map((r) => r.key);
}

export async function undoHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const body = await readJson(req);
  const opId = typeof body === "object" && body !== null ? (body as { opId?: unknown }).opId : undefined;
  if (typeof opId !== "number" || !Number.isInteger(opId) || opId < 1) {
    return badRequest("opId must be a positive integer");
  }
  const db = ctx.writeDb();
  const keys = opKeys(db, opId);
  const result = undoStateOp(db, opId, ctx.now().toISOString());
  let res: UndoResponse;
  switch (result.kind) {
    case "undone":
      res = {
        result: "undone",
        githubApplied: result.githubApplied,
        rows: deriveNow(ctx, db, keys),
      };
      return Response.json(res);
    case "notFound":
      res = { result: "notFound" };
      return Response.json(res, { status: 404 });
    case "superseded":
    case "alreadyUndone":
      res = { result: result.kind };
      return Response.json(res, { status: 409 });
  }
}

/** Asks the worker to poll on its next tick. */
export async function refreshHandler(_req: Request, ctx: ServerCtx): Promise<Response> {
  const now = ctx.now().toISOString();
  setMeta(ctx.writeDb(), META.pollRequestedAt, now, now);
  return Response.json({ requestedAt: now }, { status: 202 });
}
