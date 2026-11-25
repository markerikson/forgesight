import type { RouteContext } from "@timber-js/app/server";
import { refreshSubjectHandler } from "../../../../../../../src/server/handlers/subject.ts";
import { runHandler } from "../../../../../../../src/server/route.ts";

export async function POST(ctx: RouteContext) {
  return runHandler(ctx.req, refreshSubjectHandler);
}
