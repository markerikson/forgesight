import type { RouteContext } from "@timber-js/app/server";
import { undoHandler } from "../../../../src/server/handlers/state.ts";
import { runHandler } from "../../../../src/server/route.ts";

export async function POST(ctx: RouteContext) {
  return runHandler(ctx.req, undoHandler);
}
