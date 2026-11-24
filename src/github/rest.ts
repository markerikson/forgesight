import {
  AuthenticationRequiredError,
  ForgeApiError,
  ForgeError,
  ForgeNetworkError,
  ForgeTimeoutError,
  InsufficientScopeError,
  NotFoundError as ForgesNotFoundError,
  RateLimitedError as ForgesRateLimitedError,
  TokenRevokedError,
} from "forges";
import { GitHubApiError, GitHubError, NotFoundError, RateLimitedError, TokenError } from "./errors.ts";
import { backoffMs, MIN_SECONDARY_PAUSE_MS } from "./graphql.ts";

/** forges does not retry 5xx, network failures or timeouts; we retry those this many times. */
export const REST_RETRIES = 3;

export interface RestRetryDeps {
  sleep: (ms: number) => Promise<void>;
  clock: () => Date;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ForgeNetworkError || error instanceof ForgeTimeoutError) return true;
  return error instanceof ForgeApiError && !(error instanceof ForgesRateLimitedError) && error.status >= 500;
}

/** Runs a forges call, retrying transient failures, and turns forges errors into ours. */
export async function withRestRetry<T>(what: string, fn: () => Promise<T>, deps: RestRetryDeps): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt < REST_RETRIES && isRetryable(error)) {
        await deps.sleep(backoffMs(attempt));
        continue;
      }
      throw translateError(what, error, deps.clock());
    }
  }
}

export function translateError(what: string, error: unknown, now: Date): Error {
  if (error instanceof GitHubError) return error;
  if (error instanceof ForgesRateLimitedError) {
    if (error.secondary) {
      const minimum = new Date(now.getTime() + MIN_SECONDARY_PAUSE_MS);
      const resetAt = error.resetAt && error.resetAt > minimum ? error.resetAt : minimum;
      return new RateLimitedError(`${what}: GitHub secondary rate limit`, resetAt, true);
    }
    return new RateLimitedError(`${what}: GitHub rate limit exhausted`, error.resetAt ?? null, false);
  }
  if (error instanceof TokenRevokedError || error instanceof AuthenticationRequiredError) {
    return new TokenError(`${what}: GitHub rejected the token (${error.status})`);
  }
  if (error instanceof InsufficientScopeError) {
    return new TokenError(`${what}: the token lacks a required scope: ${error.message}`);
  }
  if (error instanceof ForgesNotFoundError) return new NotFoundError(`${what}: not found`);
  if (error instanceof ForgeApiError) {
    return new GitHubApiError(`${what}: HTTP ${error.status}: ${error.body.slice(0, 200)}`, error.status);
  }
  if (error instanceof ForgeError) return new GitHubApiError(`${what}: ${error.message}`, 0);
  return error instanceof Error ? error : new Error(String(error));
}
