import { describe, expect, test } from "bun:test";
import { RateLimitedError as ForgesRateLimitedError, ForgeApiError, ForgeNetworkError } from "forges";
import type { Notification, Page } from "forges";
import { Governor, MemoryApiCallLog } from "./budget.ts";
import { createGitHubClient } from "./client.ts";
import { GitHubApiError, NotFoundError, RateLimitedError, TokenError } from "./errors.ts";
import { FakeGitHubClient, fakeThread } from "./fake.ts";
import { pagesUntil, toPollResult } from "./notifications.ts";
import { REST_RETRIES, translateError, withRestRetry } from "./rest.ts";
import { toCompare, toNotificationThread } from "./schemas.ts";
import { checkScopes, resolveToken } from "./token.ts";
import type { ApiCallRecord, NotificationThread } from "./types.ts";

const NOW = new Date("2026-11-23T12:00:00Z");
const clock = () => NOW;

function call(overrides: Partial<ApiCallRecord>): ApiCallRecord {
  return {
    at: NOW,
    resource: "rest",
    workClass: "notifications",
    request: "GET /notifications",
    status: 200,
    cost: null,
    remaining: null,
    resetAt: null,
    durationMs: 10,
    ...overrides,
  };
}

function restNotification(id: string, updatedAt: string) {
  return {
    id,
    repository: { full_name: "octo/repo" },
    subject: { title: `T${id}`, url: `https://api.github.com/repos/octo/repo/issues/${id}`, type: "Issue" },
    reason: "mention",
    unread: true,
    updated_at: updatedAt,
    last_read_at: null,
    url: "ignored extra field",
  };
}

function page(raws: unknown[], extra: Partial<Page<Notification>> = {}): Page<Notification> {
  return { items: raws.map((raw) => ({ raw }) as Notification), ...extra };
}

describe("Governor", () => {
  test("REST spend skips 304s and calls older than an hour", () => {
    const log = new MemoryApiCallLog();
    const governor = new Governor(log, { graphqlPerHour: 1000, restPerHour: 10 }, clock);
    for (let i = 0; i < 8; i++) governor.record(call({}));
    governor.record(call({ status: 304 }));
    governor.record(call({ at: new Date(NOW.getTime() - 61 * 60_000) }));
    expect(log.spendSince("rest", new Date(NOW.getTime() - 3600_000))).toBe(8);
    expect(governor.canSpend("rest", "backfill")).toBe(false);
    expect(governor.canSpend("rest", "enrich")).toBe(true);
    expect(governor.canSpend("graphql", "backfill")).toBe(true);
  });

  test("GraphQL spend sums cost", () => {
    const governor = new Governor(new MemoryApiCallLog(), { graphqlPerHour: 100, restPerHour: 10 }, clock);
    governor.record(call({ resource: "graphql", cost: 60 }));
    governor.record(call({ resource: "graphql", cost: 45 }));
    expect([...governor.allowed("graphql")]).toEqual(["notifications", "writeback"]);
  });

  test("low header remaining limits work until reset", () => {
    const governor = new Governor(new MemoryApiCallLog(), { graphqlPerHour: 1000, restPerHour: 1000 }, clock);
    governor.record(call({ remaining: 100, resetAt: new Date(NOW.getTime() + 60_000) }));
    expect(governor.canSpend("rest", "enrich")).toBe(false);
    expect(governor.canSpend("rest", "writeback")).toBe(true);
  });

  test("a secondary limit pauses both resources", () => {
    let now = NOW;
    const governor = new Governor(new MemoryApiCallLog(), { graphqlPerHour: 1000, restPerHour: 1000 }, () => now);
    governor.noteSecondaryLimit(new Date(NOW.getTime() + 60_000));
    expect(governor.allowed("rest").size).toBe(0);
    expect(governor.allowed("graphql").size).toBe(0);
    now = new Date(NOW.getTime() + 61_000);
    expect(governor.pausedUntil()).toBeNull();
    expect(governor.canSpend("rest", "backfill")).toBe(true);
  });
});

describe("token", () => {
  test("prefers GITHUB_TOKEN, then gh", () => {
    expect(resolveToken({ env: { GITHUB_TOKEN: " abc\n" }, ghAuthToken: () => "gh" })).toBe("abc");
    expect(resolveToken({ env: {}, ghAuthToken: () => "gho_x\n" })).toBe("gho_x");
    expect(() => resolveToken({ env: {}, ghAuthToken: () => null })).toThrow(TokenError);
  });

  test("scope check", () => {
    expect(() => checkScopes("gho_x", "gist, read:org, repo")).not.toThrow();
    expect(() => checkScopes("ghp_x", "repo, notifications")).not.toThrow();
    expect(() => checkScopes("ghp_x", "repo")).toThrow(/notifications/);
    expect(() => checkScopes("gho_x", "gist")).toThrow(/repo/);
    expect(() => checkScopes("github_pat_x", null)).toThrow(/fine-grained/);
  });
});

describe("schemas", () => {
  test("flattens a REST notification and keeps raw", () => {
    const raw = restNotification("7", "2026-11-23T10:00:00Z");
    const thread = toNotificationThread(raw);
    expect(thread).toMatchObject({ id: "7", repo: "octo/repo", subjectType: "Issue", reason: "mention" });
    expect(thread.raw).toBe(raw);
  });

  test("rejects an unexpected shape", () => {
    expect(() => toNotificationThread({ id: 7 })).toThrow(GitHubApiError);
  });

  test("maps compare", () => {
    const c = toCompare({
      status: "diverged",
      ahead_by: 2,
      behind_by: 1,
      merge_base_commit: { sha: "base" },
      commits: [{ sha: "a" }, { sha: "b" }],
      files: [{ filename: "x.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    expect(c).toMatchObject({ aheadBy: 2, mergeBaseSha: "base", commitShas: ["a", "b"] });
    expect(c.files[0]).toEqual({
      filename: "x.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: null,
      previousFilename: null,
    });
  });
});

describe("notification pages", () => {
  test("poll result", () => {
    const next = new Date(NOW.getTime() + 60_000);
    expect(toPollResult(page([], { notModified: true, nextPollAt: next }), NOW)).toEqual({
      kind: "notModified",
      nextPollAt: next,
    });
    expect(toPollResult(page([], { throttled: true }), NOW).kind).toBe("notModified");
    const changed = toPollResult(page([restNotification("1", "2026-11-23T10:00:00Z")], { etag: '"e"' }), NOW);
    expect(changed.kind === "changed" && changed.etag).toBe('"e"');
  });

  test("backfill stops at the first thread older than the cutoff", async () => {
    const pages = [
      page([restNotification("1", "2026-11-23T10:00:00Z")], { cursor: { nextUrl: "p2" } }),
      page([restNotification("2", "2026-11-20T10:00:00Z"), restNotification("3", "2026-11-01T00:00:00Z")], {
        cursor: { nextUrl: "p3" },
      }),
      page([restNotification("4", "2026-10-01T00:00:00Z")]),
    ];
    const cursors: unknown[] = [];
    const seen: NotificationThread[][] = [];
    for await (const threads of pagesUntil(async (cursor) => {
      cursors.push(cursor);
      return pages[cursors.length - 1] ?? page([]);
    }, new Date("2026-11-10T00:00:00Z"))) {
      seen.push(threads);
    }
    expect(seen.map((p) => p.map((t) => t.id))).toEqual([["1"], ["2"]]);
    expect(cursors).toEqual([undefined, { nextUrl: "p2" }]);
  });
});

describe("REST retry", () => {
  const deps = { sleep: async () => {}, clock };

  test("retries 5xx and network errors, then translates", async () => {
    let attempts = 0;
    const result = await withRestRetry(
      "x",
      async () => {
        attempts++;
        if (attempts === 1) throw new ForgeNetworkError("reset");
        if (attempts === 2) throw new ForgeApiError("bad gateway", 502, "");
        return "ok";
      },
      deps,
    );
    expect(result).toBe("ok");

    attempts = 0;
    const failing = withRestRetry(
      "x",
      async () => {
        attempts++;
        throw new ForgeNetworkError("reset");
      },
      deps,
    );
    expect(failing).rejects.toThrow(GitHubApiError);
    await failing.catch(() => {});
    expect(attempts).toBe(REST_RETRIES + 1);
  });

  test("translates secondary limits with a 60s minimum", () => {
    const error = new ForgesRateLimitedError("slow down", 403, "", {
      secondary: true,
      resetAt: new Date(NOW.getTime() + 5_000),
    });
    const out = translateError("x", error, NOW);
    expect(out).toBeInstanceOf(RateLimitedError);
    expect((out as RateLimitedError).secondary).toBe(true);
    expect((out as RateLimitedError).resetAt).toEqual(new Date(NOW.getTime() + 60_000));
  });
});

describe("createGitHubClient", () => {
  function setup(respond: (url: URL, init: RequestInit | undefined) => Response) {
    const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const log = new MemoryApiCallLog();
    const governor = new Governor(log, { graphqlPerHour: 1000, restPerHour: 1000 }, clock);
    const client = createGitHubClient({ budget: { graphqlPerHour: 1000, restPerHour: 1000 } }, "gho_test", {
      governor,
      clock,
      sleep: async () => {},
      fetch: async (input, init) => {
        const url = new URL(input);
        requests.push({ url, init });
        return respond(url, init);
      },
    });
    return { client, requests, log };
  }

  test("a poll with an etag sends If-None-Match and records the 304", async () => {
    const { client, requests, log } = setup(
      () => new Response(null, { status: 304, headers: { "x-poll-interval": "60", etag: '"e1"' } }),
    );
    const result = await client.pollNotifications({ etag: '"e1"', force: true });
    expect(result.kind).toBe("notModified");
    expect(new Headers(requests[0]?.init?.headers).get("if-none-match")).toBe('"e1"');
    expect(requests[0]?.url.searchParams.get("all")).toBe("true");
    expect(log.calls.map((c) => [c.status, c.workClass])).toEqual([[304, "notifications"]]);
  });

  test("a changed poll returns threads and the new etag", async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify([restNotification("9", "2026-11-23T11:00:00Z")]), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"e2"', "x-poll-interval": "60" },
        }),
    );
    const result = await client.pollNotifications({ force: true });
    expect(result.kind === "changed" && [result.etag, result.threads.map((t) => t.subjectTitle)]).toEqual([
      '"e2"',
      ["T9"],
    ]);
  });

  test("viewerLogin reads the login and accepts a gho_ token with repo", async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify({ login: "mark" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-oauth-scopes": "gist, read:org, repo" },
        }),
    );
    expect(await client.viewerLogin()).toBe("mark");
  });

  test("markDone records a writeback call and a 404 becomes NotFoundError", async () => {
    const { client, log, requests } = setup(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    expect(client.markDone("123")).rejects.toThrow(NotFoundError);
    await client.markDone("123").catch(() => {});
    expect(requests[0]?.url.pathname).toBe("/notifications/threads/123");
    expect(log.calls[0]?.workClass).toBe("writeback");
  });
});

describe("FakeGitHubClient", () => {
  test("serves 304s for an unchanged etag and hides done threads", async () => {
    const fake = new FakeGitHubClient(clock);
    fake.setThreads(fakeThread({ id: "1" }), fakeThread({ id: "2", updatedAt: "2026-11-23T13:00:00Z" }));
    const first = await fake.pollNotifications({});
    expect(first.kind === "changed" && first.threads.map((t) => t.id)).toEqual(["2", "1"]);
    const etag = first.kind === "changed" ? first.etag : "";
    expect((await fake.pollNotifications({ etag })).kind).toBe("notModified");
    await fake.markDone("2");
    const after = await fake.pollNotifications({ etag });
    expect(after.kind === "changed" && after.threads.map((t) => t.id)).toEqual(["1"]);
    expect(fake.getCommit("octo/repo", "abc")).rejects.toThrow(NotFoundError);
  });
});
