import {
  type SubjectDetail,
  type SubjectView,
  type SubjectWorkstream,
  buildSubjectDetail,
  subjectWorkstream,
} from "../../core/index.ts";
import { latestWorkstreamSummaries } from "../../store/llm.ts";
import { getPrTexts } from "../../store/pr-texts.ts";
import { threadsForSubject } from "../../store/threads.ts";
import { getView } from "../../store/views.ts";
import { getWorkstreamState, toWorkstream, workstreamForSubject } from "../../store/workstreams.ts";
import type { ServerCtx } from "../ctx.ts";

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
    const listed = getPrTexts(
      ctx.db,
      ws.repo,
      ws.members.map((k) => Number(k.slice(k.lastIndexOf("#") + 1))).filter((n) => Number.isInteger(n) && n > 0),
    );
    const titleOf = (k: string) => {
      const row = getView(ctx.db, k)?.row as { title?: string } | undefined;
      return row?.title ?? listed.get(Number(k.slice(k.lastIndexOf("#") + 1)))?.title ?? null;
    };
    const input = {
      workstream: ws,
      state: getWorkstreamState(ctx.db, ws.id),
      summary: latestWorkstreamSummaries(ctx.db, [ws.id]).get(ws.id) ?? null,
    };
    workstream = subjectWorkstream(input, key, titleOf);
  }
  return buildSubjectDetail(view.detail as unknown as SubjectView, threadsForSubject(ctx.db, key), workstream);
}

export async function subjectHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const key = subjectKeyFromPath(new URL(req.url).pathname);
  if (!key) return Response.json({ error: "bad_request", message: "Unrecognized subject path" }, { status: 400 });
  const detail = readSubject(ctx, key);
  if (!detail) return Response.json({ error: "not_found", message: `No view for ${key}` }, { status: 404 });
  return Response.json(detail);
}
