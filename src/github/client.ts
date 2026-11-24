import { AsyncLocalStorage } from "node:async_hooks";
import type { Cursor, NotificationListOptions, NotificationRef } from "forges";
import { github } from "forges/github";
import type { Config } from "../core/config.ts";
import { Governor, MemoryApiCallLog } from "./budget.ts";
import { RateLimitedError } from "./errors.ts";
import { createGraphqlRunner, type FetchFn, quotaFromHeaders } from "./graphql.ts";
import {
  type FetchNotificationPage,
  NOTIFICATIONS_PER_PAGE,
  allPages,
  pagesUntil,
  toPollResult,
} from "./notifications.ts";
import { withRestRetry } from "./rest.ts";
import { toCommitDetail, toCompare, toLogin } from "./schemas.ts";
import { checkScopes } from "./token.ts";
import type { GitHubClient, NotificationThread, WorkClass } from "./types.ts";

const USER_AGENT = "forgesight";

export interface GitHubClientDeps {
  /** Records every call and tracks rate-limit pauses. Defaults to one with an in-memory log. */
  governor?: Governor;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
}

function threadRef(id: string): NotificationRef {
  return { forge: "github", instance: "github.com", id };
}

function encodeRepo(repo: string): string {
  return repo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function createGitHubClient(
  config: Pick<Config, "budget">,
  token: string,
  deps: GitHubClientDeps = {},
): GitHubClient {
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const baseFetch = deps.fetch ?? fetch;
  const governor = deps.governor ?? new Governor(new MemoryApiCallLog(), config.budget, clock);
  const workClassContext = new AsyncLocalStorage<WorkClass>();

  /** Every request forges sends passes through here, 304s included, so each one gets an `api_calls` row. */
  const recordingFetch: FetchFn = async (input, init) => {
    const startedAt = clock();
    const url = new URL(input);
    const isGraphql = url.pathname === "/graphql";
    const record = (status: number, headers: Headers | null) => {
      const quota = headers ? quotaFromHeaders(headers) : null;
      governor.record({
        at: startedAt,
        resource: isGraphql ? "graphql" : "rest",
        workClass: workClassContext.getStore() ?? "notifications",
        request: `${init?.method ?? "GET"} ${url.pathname}${url.search}`,
        status,
        // forges does not ask for `rateLimit` on its own GraphQL queries; count each as 1 point.
        cost: isGraphql ? 1 : null,
        remaining: quota?.remaining ?? null,
        resetAt: quota?.resetAt ?? null,
        durationMs: clock().getTime() - startedAt.getTime(),
      });
    };
    try {
      const response = await baseFetch(input, init);
      record(response.status, response.headers);
      return response;
    } catch (error) {
      record(0, null);
      throw error;
    }
  };

  const gh = github({ auth: { type: "token", token }, fetch: recordingFetch, userAgent: USER_AGENT });
  const runGraphql = createGraphqlRunner({
    token,
    fetch: baseFetch,
    sleep,
    clock,
    userAgent: USER_AGENT,
    onCall: (call) => governor.record(call),
  });

  async function run<T>(workClass: WorkClass, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await workClassContext.run(workClass, () => withRestRetry(what, fn, { sleep, clock }));
    } catch (error) {
      if (error instanceof RateLimitedError && error.secondary && error.resetAt) {
        governor.noteSecondaryLimit(error.resetAt);
      }
      throw error;
    }
  }

  function pageFetcher(workClass: WorkClass, what: string, options: NotificationListOptions): FetchNotificationPage {
    return (cursor: Cursor | undefined) =>
      run(workClass, what, () => gh.notifications.list(cursor ? { ...options, cursor } : options).page());
  }

  let login: string | null = null;

  return {
    async pollNotifications(opts) {
      const page = await run("notifications", "poll notifications", () =>
        gh.notifications
          .list({
            all: true,
            perPage: NOTIFICATIONS_PER_PAGE,
            ...(opts.force ? { force: true } : {}),
            ...(opts.etag ? { cursor: { etag: opts.etag } } : {}),
          })
          .page(),
      );
      return toPollResult(page, clock());
    },

    listNotificationsSince(since: Date): AsyncIterable<NotificationThread[]> {
      return allPages(
        pageFetcher("notifications", "list notifications since", {
          all: true,
          since,
          perPage: NOTIFICATIONS_PER_PAGE,
          force: true,
        }),
      );
    },

    listNotificationsBefore(cutoff: Date): AsyncIterable<NotificationThread[]> {
      return pagesUntil(
        pageFetcher("backfill", "backfill notifications", { all: true, perPage: NOTIFICATIONS_PER_PAGE, force: true }),
        cutoff,
      );
    },

    async markDone(threadId) {
      await run("writeback", `mark thread ${threadId} done`, () => gh.notifications.markDone(threadRef(threadId)));
    },

    async markRead(threadId) {
      await run("writeback", `mark thread ${threadId} read`, () =>
        gh.request("PATCH", `/notifications/threads/${encodeURIComponent(threadId)}`, { mutates: true }),
      );
    },

    async unsubscribe(threadId) {
      await run("writeback", `unsubscribe thread ${threadId}`, () =>
        gh.notifications.unsubscribe(threadRef(threadId)),
      );
    },

    async resubscribe(threadId) {
      await run("writeback", `resubscribe thread ${threadId}`, () =>
        gh.request("PUT", `/notifications/threads/${encodeURIComponent(threadId)}/subscription`, {
          body: { ignored: false },
          mutates: true,
        }),
      );
    },

    async graphql(query, variables, opts) {
      try {
        return await runGraphql(query, variables, opts);
      } catch (error) {
        if (error instanceof RateLimitedError && error.secondary && error.resetAt) {
          governor.noteSecondaryLimit(error.resetAt);
        }
        throw error;
      }
    },

    async getCommit(repo, sha) {
      const response = await run("rebase", `get commit ${repo}@${sha}`, () =>
        gh.request<unknown>("GET", `/repos/${encodeRepo(repo)}/commits/${encodeURIComponent(sha)}`),
      );
      return toCommitDetail(response.data);
    },

    async compare(repo, base, head) {
      const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      const response = await run("rebase", `compare ${repo} ${base}...${head}`, () =>
        gh.request<unknown>("GET", `/repos/${encodeRepo(repo)}/compare/${range}`),
      );
      return toCompare(response.data);
    },

    async viewerLogin() {
      if (login !== null) return login;
      const response = await run("notifications", "get viewer", () => gh.request<unknown>("GET", "/user"));
      checkScopes(token, response.headers.get("x-oauth-scopes"));
      login = toLogin(response.data);
      return login;
    },
  };
}
