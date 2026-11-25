import type { RouteContext } from "@timber-js/app/server";
import { workstreamStateHandler } from "../../../../src/server/handlers/workstreams.ts";
import { runHandler } from "../../../../src/server/route.ts";

export async function POST(ctx: RouteContext) {
  return runHandler(ctx.req, workstreamStateHandler);
}
