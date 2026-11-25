import { type SubjectDetail, type SubjectView, buildSubjectDetail, subjectWorkstream } from "../../core/index.ts";
import { threadsForSubject } from "../../store/threads.ts";
import { getView } from "../../store/views.ts";
import type { ServerCtx } from "../ctx.ts";
import { loadWorkstreamInputs } from "./inbox.ts";

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
  const input = loadWorkstreamInputs(ctx).find((w) => w.workstream.members.includes(key));
  const workstream = input
    ? subjectWorkstream(input, key, (k) => {
        const row = getView(ctx.db, k)?.row as { title?: string } | undefined;
        return row?.title ?? null;
      })
    : null;
  return buildSubjectDetail(view.detail as unknown as SubjectView, threadsForSubject(ctx.db, key), workstream);
}

export async function subjectHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const key = subjectKeyFromPath(new URL(req.url).pathname);
  if (!key) return Response.json({ error: "bad_request", message: "Unrecognized subject path" }, { status: 400 });
  const detail = readSubject(ctx, key);
  if (!detail) return Response.json({ error: "not_found", message: `No view for ${key}` }, { status: 404 });
  return Response.json(detail);
}
