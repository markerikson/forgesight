import { type InboxPayload, type InboxRow, buildInboxPayload } from "../../core/index.ts";
import { listViews } from "../../store/views.ts";
import type { ServerCtx } from "../ctx.ts";

export function readInbox(ctx: ServerCtx, includeHidden: boolean): InboxPayload {
  // The worker writes `row` with `toViewRecord`, so the stored JSON is an InboxRow.
  const rows = listViews(ctx.db, { includeHidden: true }).map((view) => view.row as unknown as InboxRow);
  return buildInboxPayload(rows, { includeHidden, now: ctx.now() });
}

export async function inboxHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const includeHidden = new URL(req.url).searchParams.get("includeHidden") === "1";
  return Response.json(readInbox(ctx, includeHidden));
}
