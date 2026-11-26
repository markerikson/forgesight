import type { Database } from "bun:sqlite";
import type { InboxRow, SubjectKey } from "../../core/index.ts";
import { isValidWorkstreamOp, type WorkstreamOp } from "../../core/workstream-state.ts";
import { workstreamDisplayName } from "../../core/inbox.ts";
import { subjectKeyOf } from "../../core/workstreams.ts";
import { latestWorkstreamSummaries } from "../../store/llm.ts";
import { applyWorkstreamOps } from "../../store/workstream-ops.ts";
import { getWorkstream, listWorkstreams, type StoredWorkstream, workstreamIdsFor } from "../../store/workstreams.ts";
import { readListing } from "../../worker/workstreams.ts";
import type { ServerCtx } from "../ctx.ts";
import { afterWorkstreamOp, snapshot, type WorkstreamSnapshot } from "./derive-now.ts";
import { badRequest, readJson } from "./state.ts";

export interface WorkstreamStateRequest {
  id: string;
  op: WorkstreamOp;
}

export interface WorkstreamStateResponse {
  opId: number;
  /** Re-derived inbox rows for subjects whose membership changed. */
  rows: Record<SubjectKey, InboxRow>;
  /** Each workstream the op named, after the op; null when it no longer exists. */
  workstreams: Record<string, WorkstreamSnapshot | null>;
}

export interface ListedWorkstream extends WorkstreamSnapshot {
  /** The name the inbox shows: a manual rename, else the summary's name, else the detected one. */
  displayName: string;
}

export interface WorkstreamsResponse {
  workstreams: ListedWorkstream[];
}

function parseRequest(body: unknown): WorkstreamStateRequest | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { id, op } = body as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) return "id must be a workstream id";
  if (!isValidWorkstreamOp(op)) return "op is not a valid workstream op";
  return { id, op };
}

/** Checks adding `key` to `ws`: it must be an open PR of the same repo in no workstream. */
function checkAdd(db: Database, ws: StoredWorkstream, key: SubjectKey): string | null {
  if (ws.members.some((m) => m.key === key)) return `${key} is already a member of ${ws.id}`;
  const current = workstreamIdsFor(db, [key]).get(key);
  if (current) return `${key} is in workstream ${current}; merge the workstreams instead`;
  const open = readListing(db, ws.repo)?.pulls.some((p) => subjectKeyOf({ repo: ws.repo, number: p.number }) === key);
  return open ? null : `${key} is not an open pull request in ${ws.repo}`;
}

/** Checks the op against the stored workstreams; returns an error message or null. */
function checkOp(
  db: Database,
  ws: StoredWorkstream,
  op: WorkstreamOp,
  other: StoredWorkstream | undefined,
): string | null {
  if (op.kind === "merge") {
    if (op.from === ws.id) return "cannot merge a workstream into itself";
    if (!other) return `workstream ${op.from} not found`;
    if (other.repo !== ws.repo) return "workstreams must be in the same repo";
  }
  if (op.kind === "remove" && !ws.members.some((m) => m.key === op.key)) {
    return `${op.key} is not a member of ${ws.id}`;
  }
  if (op.kind === "add") return checkAdd(db, ws, op.key);
  return null;
}

export async function workstreamStateHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const parsed = parseRequest(await readJson(req));
  if (typeof parsed === "string") return badRequest(parsed);
  const db = ctx.writeDb();
  const ws = getWorkstream(db, parsed.id);
  if (!ws) return Response.json({ error: "not_found", ids: [parsed.id] }, { status: 404 });
  const other = parsed.op.kind === "merge" ? getWorkstream(db, parsed.op.from) : undefined;
  const problem = checkOp(db, ws, parsed.op, other);
  if (problem) return badRequest(problem);

  const before = other ? [ws, other] : [ws];
  const { opId } = applyWorkstreamOps(db, parsed.id, parsed.op, ctx.now().toISOString());
  const effects = afterWorkstreamOp(ctx, db, { target: { kind: "workstream", id: parsed.id }, op: parsed.op }, before);
  const body: WorkstreamStateResponse = { opId, ...effects };
  return Response.json(body);
}

/** Lists stored workstreams with their state, optionally for one repo (`?repo=owner/name`). */
export async function workstreamsHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const repo = new URL(req.url).searchParams.get("repo") ?? undefined;
  const db = ctx.db;
  const stored = listWorkstreams(db, repo);
  const summaries = latestWorkstreamSummaries(
    db,
    stored.map((ws) => ws.id),
  );
  const workstreams = stored.flatMap((ws): ListedWorkstream[] => {
    const snap = snapshot(db, ws.id);
    if (!snap) return [];
    return [{ ...snap, displayName: workstreamDisplayName(snap, summaries.get(ws.id)?.name) }];
  });
  const body: WorkstreamsResponse = { workstreams };
  return Response.json(body);
}
