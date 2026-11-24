import { type ServerCtx, NotReadyError, getCtx } from "./ctx.ts";

export type Handler = (req: Request, ctx: ServerCtx) => Promise<Response>;

/** Runs a handler with the process context. A database that is missing or behind answers 503. */
export async function runHandler(req: Request, handler: Handler): Promise<Response> {
  let ctx: ServerCtx;
  try {
    ctx = await getCtx();
  } catch (err) {
    if (err instanceof NotReadyError) {
      return Response.json({ error: "not_ready", message: err.message }, { status: 503 });
    }
    throw err;
  }
  return handler(req, ctx);
}
