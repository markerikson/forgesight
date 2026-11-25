import {
  type SubjectDetail,
  type SubjectView,
  type SubjectWorkstream,
  buildSubjectDetail,
  subjectBody,
  subjectWorkstream,
} from "../../core/index.ts";
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
  queueMissingBody(ctx, key);
  return buildSubjectDetail(detail, threadsForSubject(ctx.db, key), workstream);
}

/**
 * Queues another fetch for a PR or issue enriched before the query asked for `body`. The
 * worker's next derive adds the description to the view, and the client refetches the open
 * subject on that view change. Skips subjects whose last fetch failed, so a deleted or
 * failing subject is not refetched on every open.
 */
function queueMissingBody(ctx: ServerCtx, key: string): void {
  const subject = getSubject(ctx.db, key);
  if (!subject || subject.kind === "other" || subject.raw == null || subject.dirtyAt !== null) return;
  if (subject.enrichError !== null) return;
  if (subjectBody(subject.raw) === undefined) markDirty(ctx.writeDb(), [key], ctx.now().toISOString());
}

export async function subjectHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const key = subjectKeyFromPath(new URL(req.url).pathname);
  if (!key) return Response.json({ error: "bad_request", message: "Unrecognized subject path" }, { status: 400 });
  const detail = readSubject(ctx, key);
  if (!detail) return Response.json({ error: "not_found", message: `No view for ${key}` }, { status: 404 });
  return Response.json(detail);
}
