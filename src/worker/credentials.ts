import { statSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "../deploy/settings.ts";
import type { TokenError } from "../github/errors.ts";
import type { GitHubClient } from "../github/types.ts";

/** Bun loads `.env` from the working directory at startup; the deploy writes the token there. */
export const ENV_PATH = join(process.cwd(), ".env");

type Env = Record<string, string | undefined>;

/** The startup environment with `.env` as it is on disk now laid over it. */
export async function currentEnv(path: string, base: Env = process.env): Promise<Env> {
  const file = Bun.file(path);
  if (!(await file.exists())) return base;
  try {
    return { ...base, ...parseEnvFile(await file.text()) };
  } catch {
    return base;
  }
}

/** Returns a check that is true once each time the file's modification time changes. */
export function fileChangeWatcher(path: string): () => boolean {
  const stamp = () => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  };
  let last = stamp();
  return () => {
    const next = stamp();
    if (next === last) return false;
    last = next;
    return true;
  };
}

/** A client whose every call throws `error`, used while the token is rejected. */
export function rejectingGitHubClient(error: TokenError): GitHubClient {
  return new Proxy({} as GitHubClient, {
    get: () => () => {
      throw error;
    },
  });
}
