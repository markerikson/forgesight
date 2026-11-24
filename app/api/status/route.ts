import type { RouteContext } from "@timber-js/app/server";
import { statusHandler } from "../../../src/server/handlers/status.ts";
import { runHandler } from "../../../src/server/route.ts";

export async function GET(ctx: RouteContext) {
  return runHandler(ctx.req, statusHandler);
}
