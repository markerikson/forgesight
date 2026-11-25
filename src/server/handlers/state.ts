import type { Database } from "bun:sqlite";
import type { InboxRow, SubjectKey } from "../../core/index.ts";
import { META } from "../../core/meta-keys.ts";
import { isValidStateOp, MAX_STATE_KEYS, type StateOp } from "../../core/state.ts";
import { setMeta } from "../../store/meta.ts";
import { applyStateOps, undoStateOp } from "../../store/state-ops.ts";
import { getSubject } from "../../store/subjects.ts";
import { mergeUndoHints, parseWorkstreamOpRecord } from "../../store/workstream-ops.ts";
import { getWorkstream, type StoredWorkstream } from "../../store/workstreams.ts";
import type { ServerCtx } from "../ctx.ts";
import {
  afterWorkstreamOp,
  deriveNow,
  type WorkstreamSnapshot,
  workstreamIdsOf,
} from "./derive-now.ts";

export const MAX_KEYS = MAX_STATE_KEYS;

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
  | {
      result: "undone";
      githubApplied: number;
      rows: Record<SubjectKey, InboxRow>;
      /** Present when the undone op was a workstream op. */
      workstreams?: Record<string, WorkstreamSnapshot | null>;
    }
  | { result: "superseded" | "alreadyUndone" | "notFound" };

export function badRequest(message: string): Response {
  return Response.json({ error: "bad_request", message }, { status: 400 });
}

export async function readJson(req: Request): Promise<unknown> {
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
  const opRow = db
    .query<{ op_json: string; prev_json: string }, [number]>("SELECT op_json, prev_json FROM state_ops WHERE id = ?")
    .get(opId);
  const wsRecord = opRow ? parseWorkstreamOpRecord(opRow.op_json) : null;
  const before = wsRecord
    ? workstreamIdsOf(wsRecord)
        .map((id) => getWorkstream(db, id))
        .filter((ws): ws is StoredWorkstream => ws !== undefined)
    : [];
  const keys = wsRecord ? [] : opKeys(db, opId);
  const result = undoStateOp(db, opId, ctx.now().toISOString());
  let res: UndoResponse;
  switch (result.kind) {
    case "undone": {
      if (wsRecord) {
        const hints = opRow && wsRecord.op.kind === "merge" ? mergeUndoHints(opRow.prev_json) : [];
        const effects = afterWorkstreamOp(ctx, db, wsRecord, before, hints);
        res = { result: "undone", githubApplied: result.githubApplied, ...effects };
      } else {
        res = {
          result: "undone",
          githubApplied: result.githubApplied,
          rows: deriveNow(ctx, db, keys),
        };
      }
      return Response.json(res);
    }
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
