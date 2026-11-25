import { ENRICH_PRIORITY, isEnrichable, needsFetchOnOpen } from "../../core/enrich-plan.ts";
import {
  type SubjectDetail,
  type SubjectFetchState,
  type SubjectView,
  type SubjectWorkstream,
  buildSubjectDetail,
  subjectBody,
  subjectWorkstream,
} from "../../core/index.ts";
import type { SubjectRecord } from "../../core/types.ts";
import { latestWorkstreamSummaries } from "../../store/llm.ts";
import { getSubject, markDirty } from "../../store/subjects.ts";
import { threadsForSubject } from "../../store/threads.ts";
import { getView } from "../../store/views.ts";
import { getWorkstreamState, toWorkstream, workstreamForSubject } from "../../store/workstreams.ts";
import type { ServerCtx } from "../ctx.ts";
import { listedPulls } from "./inbox.ts";

/**
 * The subject key from `/api/subjects/<owner>/<repo>/<number>` or
 * `/api/subjects/<owner>/<repo>/@<threadId>` (the client's `subjectPath`).
 */
export function subjectKeyFromPath(pathname: string): string | null {
  const match = /\/api\/subjects\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  const owner = decode(match[1]);
  const repo = decode(match[2]);
  const last = decode(match[3]);
  if (!owner || !repo || !last) return null;
  if (/^\d+$/.test(last)) return `${owner}/${repo}#${last}`;
  if (last.startsWith("@") && last.length > 1) return `${owner}/${repo}${last}`;
  return null;
}

function decode(part: string | undefined): string | null {
  try {
    return part ? decodeURIComponent(part) : null;
  } catch {
    return null;
  }
}

export function readSubject(ctx: ServerCtx, key: string): SubjectDetail | null {
  const view = getView(ctx.db, key);
  if (!view) return null;
  // The worker writes `detail` with `toViewRecord`, so the stored JSON is a SubjectView.
  const stored = workstreamForSubject(ctx.db, key);
  let workstream: SubjectWorkstream | null = null;
  if (stored) {
    const ws = toWorkstream(stored);
    const listed = listedPulls(ctx, ws.repo, ws.members);
    const titleOf = (k: string) => {
      const row = getView(ctx.db, k)?.row as { title?: string } | undefined;
      return row?.title || listed[k]?.title || null;
    };
    const input = {
      workstream: ws,
      state: getWorkstreamState(ctx.db, ws.id),
      summary: latestWorkstreamSummaries(ctx.db, [ws.id]).get(ws.id) ?? null,
    };
    workstream = subjectWorkstream(input, key, titleOf);
  }
  const detail = view.detail as unknown as SubjectView;
  const threads = threadsForSubject(ctx.db, key);
  const subject = getSubject(ctx.db, key);
  const { refreshable, fetching } = subject
    ? fetchState(ctx, subject, threads[0]?.updatedAt ?? null)
    : { refreshable: false, fetching: false };
  return buildSubjectDetail(detail, threads, workstream, { refreshable, fetching });
}

interface FetchState extends SubjectFetchState {
  /** Opening the subject should queue it as urgent. */
  fetchOnOpen: boolean;
}

/**
 * Reading a subject never queues it, because the list prefetches its neighbors through the same
 * request. `fetching` says whether opening it fetches (or already queued) it; the preview then
 * posts `refresh?ifNeeded=1`, which queues it as urgent.
 */
function fetchState(
  ctx: ServerCtx,
  subject: SubjectRecord,
  threadUpdatedAt = threadsForSubject(ctx.db, subject.subjectKey)[0]?.updatedAt ?? null,
): FetchState {
  const refreshable = isEnrichable(subject.kind, ctx.config);
  const opened = {
    kind: subject.kind,
    timelineSyncedUntil: subject.timelineSyncedUntil,
    enrichError: subject.enrichError,
    missingBody: subject.raw != null && subjectBody(subject.raw) === undefined,
    threadUpdatedAt,
  };
  const queued = subject.dirtyAt !== null;
  const fetchOnOpen = (queued && refreshable && subject.enrichError === null) || needsFetchOnOpen(opened, ctx.config);
  // A failed fetch waiting to retry at its old priority is not shown as loading, so Refresh stays enabled.
  const urgentQueued = queued && refreshable && subject.priority >= ENRICH_PRIORITY.urgent;
  return { refreshable, fetching: fetchOnOpen || urgentQueued, fetchOnOpen };
}

function markUrgent(ctx: ServerCtx, key: string): void {
  markDirty(ctx.writeDb(), [key], ctx.now().toISOString(), ENRICH_PRIORITY.urgent);
}

/** Readable `fetching` state for one subject, after a forced refresh. */
export interface RefreshResponse {
  key: string;
  fetching: boolean;
}

/**
 * `POST /api/subjects/<owner>/<repo>/<number>/refresh`: queues an urgent fetch even when the
 * subject looks current or its last fetch failed. With `?ifNeeded=1` (the preview opening a
 * subject), queues it only when it was never fetched, lacks its description, has a notification
 * newer than its last fetch, or is already queued. The urgent enrich job picks it up on the
 * worker's next tick.
 */
export async function refreshSubjectHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const url = new URL(req.url);
  const key = subjectKeyFromPath(url.pathname.replace(/\/refresh\/?$/, ""));
  if (!key) return Response.json({ error: "bad_request", message: "Unrecognized subject path" }, { status: 400 });
  const subject = getSubject(ctx.db, key);
  if (!subject) return Response.json({ error: "not_found", message: `No subject ${key}` }, { status: 404 });
  if (!isEnrichable(subject.kind, ctx.config)) {
    return Response.json({ error: "bad_request", message: `${key} cannot be fetched` }, { status: 400 });
  }
  if (url.searchParams.get("ifNeeded") === "1") {
    const state = fetchState(ctx, subject);
    if (state.fetchOnOpen && subject.priority < ENRICH_PRIORITY.urgent) markUrgent(ctx, key);
    const body: RefreshResponse = { key, fetching: state.fetching };
    return Response.json(body, { status: state.fetchOnOpen ? 202 : 200 });
  }
  markUrgent(ctx, key);
  const body: RefreshResponse = { key, fetching: true };
  return Response.json(body, { status: 202 });
}

export async function subjectHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const key = subjectKeyFromPath(new URL(req.url).pathname);
  if (!key) return Response.json({ error: "bad_request", message: "Unrecognized subject path" }, { status: 400 });
  const detail = readSubject(ctx, key);
  if (!detail) return Response.json({ error: "not_found", message: `No view for ${key}` }, { status: 404 });
  return Response.json(detail);
}
