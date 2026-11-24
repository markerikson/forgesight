import type { RouteContext } from "@timber-js/app/server";
import { healthHandler } from "../../../src/server/handlers/health.ts";

export async function GET(ctx: RouteContext) {
  return healthHandler(ctx.req);
}
