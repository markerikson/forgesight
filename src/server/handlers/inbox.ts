import {
  type InboxPayload,
  type InboxRow,
  type WorkstreamInput,
  buildInboxPayload,
} from "../../core/index.ts";
import { listViews } from "../../store/views.ts";
import type { ServerCtx } from "../ctx.ts";

// PLACEHOLDER: replaced by m4-store branch at merge. Reads every workstream with
// its workstream_state row and latest summary.
export function loadWorkstreamInputs(_ctx: ServerCtx): WorkstreamInput[] {
  return [];
}

export function readInbox(ctx: ServerCtx, includeHidden: boolean): InboxPayload {
  // The worker writes `row` with `toViewRecord`, so the stored JSON is an InboxRow.
  const rows = listViews(ctx.db, { includeHidden: true }).map((view) => view.row as unknown as InboxRow);
  return buildInboxPayload(rows, { includeHidden, now: ctx.now(), workstreams: loadWorkstreamInputs(ctx) });
}

export async function inboxHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const includeHidden = new URL(req.url).searchParams.get("includeHidden") === "1";
  return Response.json(readInbox(ctx, includeHidden));
}
