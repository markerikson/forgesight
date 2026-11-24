import type { RouteContext } from "@timber-js/app/server";
import { stateHandler } from "../../../src/server/handlers/state.ts";
import { runHandler } from "../../../src/server/route.ts";

export async function POST(ctx: RouteContext) {
  return runHandler(ctx.req, stateHandler);
}
