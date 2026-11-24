import type { RouteContext } from "@timber-js/app/server";
import { refreshHandler } from "../../../src/server/handlers/state.ts";
import { runHandler } from "../../../src/server/route.ts";

export async function POST(ctx: RouteContext) {
  return runHandler(ctx.req, refreshHandler);
}
