import { expect, test } from "bun:test";
import { GitHubApiError } from "../errors.ts";
import { FakeGitHubClient } from "../fake.ts";
import { fetchOpenPulls, OPEN_PULLS_QUERY, openPullsMetaKey, parseOpenPullsPage } from "./open-pulls.ts";

function node(number: number) {
  return {
    number,
    title: `PR ${number}`,
    author: number === 2 ? null : { login: "dependabot", __typename: "Bot" },
    headRefName: `b${number}`,
    baseRefName: "main",
    headRefOid: `sha${number}`,
    updatedAt: "2026-11-23T10:00:00Z",
    isDraft: number === 3,
  };
}

function page(numbers: number[], endCursor: string | null) {
  return {
    data: {
      repository: {
        pullRequests: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes: numbers.map(node) },
      },
    },
    cost: 1,
    remaining: 4000,
    resetAt: new Date("2026-11-23T13:00:00Z"),
    gatewayErrors: 0,
  };
}

test("fetchOpenPulls follows cursors and maps fields", async () => {
  const gh = new FakeGitHubClient();
  gh.graphqlHandler = (_query, variables) => (variables.after === null ? page([1, 2], "c1") : page([3], null));
  const listing = await fetchOpenPulls(gh, "octo/repo", () => new Date("2026-11-23T12:00:00Z"));

  expect(listing.repo).toBe("octo/repo");
  expect(listing.fetchedAt).toBe("2026-11-23T12:00:00.000Z");
  expect(listing.pulls.map((p) => p.number)).toEqual([1, 2, 3]);
  expect(listing.pulls[0]).toEqual({
    number: 1,
    title: "PR 1",
    author: "dependabot",
    authorType: "Bot",
    headRef: "b1",
    baseRef: "main",
    headSha: "sha1",
    updatedAt: "2026-11-23T10:00:00Z",
    isDraft: false,
  });
  expect(listing.pulls[1]?.author).toBeNull();
  expect(gh.calls.map((c) => (c.method === "graphql" ? [c.variables.after, c.opts.workClass] : null))).toEqual([
    [null, "openPulls"],
    ["c1", "openPulls"],
  ]);
  expect(gh.calls[0]).toMatchObject({ query: OPEN_PULLS_QUERY, variables: { owner: "octo", name: "repo" } });
});

test("parseOpenPullsPage rejects a bad shape", () => {
  expect(() => parseOpenPullsPage({ repository: null })).toThrow(GitHubApiError);
});

test("openPullsMetaKey", () => {
  expect(openPullsMetaKey("octo/repo")).toBe("openPulls.octo/repo");
});
