import { GqlError, type GqlErrorKind, RateLimitedError, TokenError } from "./errors.ts";
import type { ApiCallRecord, GqlErrorEntry, GqlOpts, GqlResult } from "./types.ts";

export const GRAPHQL_URL = "https://api.github.com/graphql";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 4;
/** A secondary limit pauses work for at least this long, whatever `retry-after` says. */
export const MIN_SECONDARY_PAUSE_MS = 60_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface GraphqlDeps {
  token: string;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
  userAgent?: string;
  /** Called once per HTTP attempt. */
  onCall?: (call: ApiCallRecord) => void;
}

export type GraphqlRunner = <T>(
  query: string,
  variables: Record<string, unknown>,
  opts: GqlOpts,
) => Promise<GqlResult<T>>;

/** Backoff before retry `attempt` (0-based): 2s, 4s, 8s ..., capped at 60s. */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 2000 * 2 ** attempt);
}

const RETRYABLE_STATUS: Record<number, GqlErrorKind> = { 502: "gateway", 503: "server", 504: "server" };
const SERVER_TIMEOUT_MESSAGE = /something went wrong|timeout|timed out/i;

interface RateLimitField {
  cost: number;
  remaining: number;
  resetAt: string;
}

interface Failure {
  kind: GqlErrorKind;
  status: number;
  message: string;
  errors?: GqlErrorEntry[];
}

export function createGraphqlRunner(deps: GraphqlDeps): GraphqlRunner {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const clock = deps.clock ?? (() => new Date());
  const headers = {
    Authorization: `bearer ${deps.token}`,
    "Content-Type": "application/json",
    "User-Agent": deps.userAgent ?? "forgesight",
  };

  return async function runGraphql<T>(
    query: string,
    variables: Record<string, unknown>,
    opts: GqlOpts,
  ): Promise<GqlResult<T>> {
    const body = JSON.stringify({ query, variables });
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let gatewayErrors = 0;
    let lastFailure: Failure | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt - 1));

      const startedAt = clock();
      const record = (status: number, cost: number | null, remaining: number | null, resetAt: Date | null) =>
        deps.onCall?.({
          at: startedAt,
          resource: "graphql",
          workClass: opts.workClass,
          request: `graphql ${opts.repo}`,
          status,
          cost,
          remaining,
          resetAt,
          durationMs: clock().getTime() - startedAt.getTime(),
        });

      let response: Response;
      let text: string;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await doFetch(GRAPHQL_URL, { method: "POST", headers, body, signal: controller.signal });
        text = await response.text();
      } catch (error) {
        record(0, null, null, null);
        const timedOut = controller.signal.aborted;
        lastFailure = {
          kind: timedOut ? "timeout" : "network",
          status: 0,
          message: timedOut ? `GraphQL request timed out after ${timeoutMs}ms` : `GraphQL network error: ${String(error)}`,
        };
        continue;
      } finally {
        clearTimeout(timer);
      }

      const headerQuota = quotaFromHeaders(response.headers);
      const { status } = response;

      if (status !== 200) {
        record(status, null, headerQuota?.remaining ?? null, headerQuota?.resetAt ?? null);
        const retryKind = RETRYABLE_STATUS[status];
        if (retryKind) {
          if (status === 502) gatewayErrors++;
          lastFailure = { kind: retryKind, status, message: `GraphQL HTTP ${status}` };
          continue;
        }
        if (status === 401) throw new TokenError(`GitHub rejected the token (401): ${text.slice(0, 200)}`);
        if (status === 403 || status === 429) {
          const limited = rateLimitFromResponse(response.headers, text, clock());
          if (limited) throw limited;
        }
        throw new GqlError(`GraphQL HTTP ${status}: ${text.slice(0, 200)}`, "http", status);
      }

      let json: { data?: Record<string, unknown> | null; errors?: GqlErrorEntry[] };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        record(status, null, headerQuota?.remaining ?? null, headerQuota?.resetAt ?? null);
        lastFailure = { kind: "server", status, message: `GraphQL returned invalid JSON: ${text.slice(0, 200)}` };
        continue;
      }

      const errors = json.errors && json.errors.length > 0 ? json.errors : undefined;
      const data = json.data ?? null;
      const rateLimit = data ? takeRateLimit(data) : null;
      const cost = rateLimit?.cost ?? 1;
      const remaining = rateLimit?.remaining ?? headerQuota?.remaining ?? 0;
      const resetAt = rateLimit ? new Date(rateLimit.resetAt) : (headerQuota?.resetAt ?? clock());
      record(status, data ? cost : null, remaining, resetAt);

      if (!data) {
        const list = errors ?? [];
        if (list.some((e) => e.type === "RATE_LIMITED")) {
          throw new RateLimitedError("GraphQL rate limit exhausted", resetAt, false);
        }
        const message = list.map((e) => e.message).join("; ") || "GraphQL returned no data";
        if (list.length > 0 && list.every((e) => SERVER_TIMEOUT_MESSAGE.test(e.message))) {
          lastFailure = { kind: "timeout", status, message, errors: list };
          continue;
        }
        throw new GqlError(message, "graphql", status, list);
      }

      return {
        data: data as T,
        cost,
        remaining,
        resetAt,
        ...(errors ? { errors } : {}),
        gatewayErrors,
      };
    }

    const failure = lastFailure ?? { kind: "network" as const, status: 0, message: "GraphQL request failed" };
    throw new GqlError(
      `${failure.message} (after ${MAX_ATTEMPTS} attempts)`,
      failure.kind,
      failure.status,
      failure.errors,
    );
  };
}

/** Removes `rateLimit` from `data` and returns it. */
function takeRateLimit(data: Record<string, unknown>): RateLimitField | null {
  const value = data["rateLimit"];
  delete data["rateLimit"];
  if (
    value &&
    typeof value === "object" &&
    "cost" in value &&
    typeof value.cost === "number" &&
    "remaining" in value &&
    typeof value.remaining === "number" &&
    "resetAt" in value &&
    typeof value.resetAt === "string"
  ) {
    return { cost: value.cost, remaining: value.remaining, resetAt: value.resetAt };
  }
  return null;
}

export function quotaFromHeaders(headers: Headers): { remaining: number; resetAt: Date } | null {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === null || reset === null) return null;
  return { remaining: Number(remaining), resetAt: new Date(Number(reset) * 1000) };
}

/** A 403/429 that is a rate limit, or null when it is some other refusal. */
export function rateLimitFromResponse(headers: Headers, body: string, now: Date): RateLimitedError | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null || /secondary rate limit/i.test(body)) {
    const seconds = retryAfter === null ? 0 : Number(retryAfter);
    const pauseMs = Math.max(Number.isFinite(seconds) ? seconds * 1000 : 0, MIN_SECONDARY_PAUSE_MS);
    return new RateLimitedError(
      `GitHub secondary rate limit: ${body.slice(0, 200)}`,
      new Date(now.getTime() + pauseMs),
      true,
    );
  }
  const quota = quotaFromHeaders(headers);
  if (quota && quota.remaining === 0) {
    return new RateLimitedError("GitHub rate limit exhausted", quota.resetAt, false);
  }
  return null;
}
