import type { RouteContext } from "@timber-js/app/server";
import { workstreamsHandler } from "../../../src/server/handlers/workstreams.ts";
import { runHandler } from "../../../src/server/route.ts";

export async function GET(ctx: RouteContext) {
  return runHandler(ctx.req, workstreamsHandler);
}
