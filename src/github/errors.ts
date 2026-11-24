/** Base class for errors thrown by `src/github`. Callers never see forges errors. */
export class GitHubError extends Error {
  override name = "GitHubError";
}

/** GitHub rate limited a request. With `secondary`, pause all work until `resetAt`. */
export class RateLimitedError extends GitHubError {
  override name = "RateLimitedError";
  constructor(
    message: string,
    readonly resetAt: Date | null,
    readonly secondary: boolean,
  ) {
    super(message);
  }
}

/** 401: the token is missing, expired or revoked. */
export class TokenError extends GitHubError {
  override name = "TokenError";
}

export class NotFoundError extends GitHubError {
  override name = "NotFoundError";
}

/** Any other non-2xx response, or a request that kept failing after retries. */
export class GitHubApiError extends GitHubError {
  override name = "GitHubApiError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type GqlErrorKind = "gateway" | "server" | "network" | "timeout" | "http" | "graphql";

/** A GraphQL request that failed after retries. `gateway` means 502: retry with a smaller query. */
export class GqlError extends GitHubError {
  override name = "GqlError";
  constructor(
    message: string,
    readonly kind: GqlErrorKind,
    readonly status: number,
    readonly errors: Array<{ message: string; type?: string }> = [],
  ) {
    super(message);
  }
}
