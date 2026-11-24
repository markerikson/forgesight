import { join } from "node:path";

/** Written by the deploy script next to package.json: `{ sha, time }`. */
export interface BuildInfo {
  sha?: string;
  time?: string;
}

export interface HealthCtx {
  root: string;
}

export interface HealthPayload {
  ok: true;
  version: string;
  buildInfo: BuildInfo | null;
}

async function readBuildInfo(root: string): Promise<BuildInfo | null> {
  const file = Bun.file(join(root, "build-info.json"));
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as BuildInfo;
  } catch {
    return null;
  }
}

/** Liveness only: does not touch the database, so it answers before migrations run. */
export async function healthHandler(
  _req: Request,
  ctx: HealthCtx = { root: process.cwd() },
): Promise<Response> {
  const buildInfo = await readBuildInfo(ctx.root);
  const payload: HealthPayload = { ok: true, version: buildInfo?.sha ?? "dev", buildInfo };
  return Response.json(payload);
}
