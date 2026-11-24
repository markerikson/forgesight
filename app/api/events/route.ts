import type { RouteContext } from "@timber-js/app/server";
import { eventsHandler } from "../../../src/server/handlers/events.ts";
import { runHandler } from "../../../src/server/route.ts";

export async function GET(ctx: RouteContext) {
  return runHandler(ctx.req, eventsHandler);
}
