import type { RouteContext } from "@timber-js/app/server";
import { inboxHandler } from "../../../src/server/handlers/inbox.ts";
import { runHandler } from "../../../src/server/route.ts";

export async function GET(ctx: RouteContext) {
  return runHandler(ctx.req, inboxHandler);
}
