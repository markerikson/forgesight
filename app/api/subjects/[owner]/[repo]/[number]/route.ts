import type { RouteContext } from "@timber-js/app/server";
import { subjectHandler } from "../../../../../../src/server/handlers/subject.ts";
import { runHandler } from "../../../../../../src/server/route.ts";

export async function GET(ctx: RouteContext) {
  return runHandler(ctx.req, subjectHandler);
}
