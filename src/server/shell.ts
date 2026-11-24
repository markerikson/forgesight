import { countViews } from "../store/views.ts";
import { NotReadyError, getCtx } from "./ctx.ts";
import { type StatusPayload, readStatus } from "./handlers/status.ts";

export type ShellData =
  | { ready: true; status: StatusPayload; viewCount: number }
  | { ready: false; message: string };

/** What the page renders on the server before the client store takes over. */
export async function loadShell(): Promise<ShellData> {
  try {
    const ctx = await getCtx();
    return { ready: true, status: readStatus(ctx), viewCount: countViews(ctx.db) };
  } catch (err) {
    if (err instanceof NotReadyError) return { ready: false, message: err.message };
    throw err;
  }
}
