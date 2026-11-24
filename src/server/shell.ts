import type { InboxPayload } from "../core/index.ts";
import { NotReadyError, getCtx } from "./ctx.ts";
import { readInbox } from "./handlers/inbox.ts";
import { type StatusPayload, readStatus } from "./handlers/status.ts";

export type ShellData =
  | { ready: true; status: StatusPayload; inbox: InboxPayload }
  | { ready: false; message: string };

/** What the page renders on the server before the client store takes over. */
export async function loadShell(): Promise<ShellData> {
  try {
    const ctx = await getCtx();
    return { ready: true, status: readStatus(ctx), inbox: readInbox(ctx, false) };
  } catch (err) {
    if (err instanceof NotReadyError) return { ready: false, message: err.message };
    throw err;
  }
}
