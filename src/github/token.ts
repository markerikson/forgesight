import { spawnSync } from "node:child_process";
import { TokenError } from "./errors.ts";

export interface TokenSource {
  env?: Record<string, string | undefined>;
  /** Runs `gh auth token`; returns stdout, or null when gh is missing or fails. */
  ghAuthToken?: () => string | null;
}

function runGhAuthToken(): string | null {
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/** `GITHUB_TOKEN`, else `gh auth token`. Throws `TokenError` when neither gives a token. */
export function resolveToken(source: TokenSource = {}): string {
  const env = source.env ?? process.env;
  const fromEnv = env["GITHUB_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;

  const fromGh = (source.ghAuthToken ?? runGhAuthToken)()?.trim();
  if (fromGh) return fromGh;

  throw new TokenError(
    "No GitHub token found. Set GITHUB_TOKEN or log in with `gh auth login` so `gh auth token` works.",
  );
}

/**
 * Checks the `x-oauth-scopes` header from `GET /user`. Classic PATs need `repo` and
 * `notifications`; `gh` OAuth tokens (`gho_`) need `repo`. Fine-grained tokens send no
 * scopes header and cannot read `/notifications`.
 */
export function checkScopes(token: string, scopesHeader: string | null): void {
  if (token.startsWith("github_pat_") || scopesHeader === null) {
    throw new TokenError(
      "This looks like a fine-grained token. GitHub's /notifications API does not accept fine-grained tokens; " +
        "use a classic token with `repo` and `notifications` scopes, or `gh auth token`.",
    );
  }

  const scopes = new Set(
    scopesHeader
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  const required = token.startsWith("gho_") ? ["repo"] : ["repo", "notifications"];
  const missing = required.filter((s) => !scopes.has(s));
  if (missing.length > 0) {
    throw new TokenError(
      `The GitHub token is missing scope(s): ${missing.join(", ")}. It has: ${[...scopes].join(", ") || "none"}.`,
    );
  }
}
