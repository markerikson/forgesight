import { join } from "node:path";
import type { BuildInfo } from "../server/handlers/health.ts";

const SHA = /^[0-9a-f]{7,40}(-dirty)?$/;

export function buildInfo(sha: string, now: Date): Required<BuildInfo> {
  if (!SHA.test(sha)) throw new Error(`Not a git sha: ${sha}`);
  return { sha, time: now.toISOString() };
}

/** Writes `build-info.json` into `root`, where `/api/health` reads it. */
export async function writeBuildInfo(root: string, sha: string, now: Date): Promise<Required<BuildInfo>> {
  const info = buildInfo(sha, now);
  await Bun.write(join(root, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}
