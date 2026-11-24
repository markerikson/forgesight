import { type } from "arktype";
import { GitHubApiError } from "../errors.ts";
import type { GitHubClient } from "../types.ts";
import { splitRepo } from "./subject-batch.ts";

export const OPEN_PULLS_QUERY = `query OpenPulls($owner: String!, $name: String!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title author { login __typename } headRefName baseRefName headRefOid updatedAt isDraft }
    }
  }
}`;

const openPull = type({
  number: "number",
  title: "string",
  author: type({ login: "string", __typename: "string" }).or("null"),
  headRefName: "string",
  baseRefName: "string",
  headRefOid: "string",
  updatedAt: "string",
  isDraft: "boolean",
});

const openPullsPage = type({
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: "boolean", endCursor: "string | null" },
      nodes: openPull.array(),
    },
  },
});

export interface OpenPull {
  number: number;
  title: string;
  author: string | null;
  authorType: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  updatedAt: string;
  isDraft: boolean;
}

/** The value stored in meta `openPulls.<repo>`. */
export interface OpenPullsListing {
  repo: string;
  fetchedAt: string;
  pulls: OpenPull[];
}

export { openPullsMetaKey } from "../../core/meta-keys.ts";

export function parseOpenPullsPage(raw: unknown): { pulls: OpenPull[]; endCursor: string | null } {
  const out = openPullsPage(raw);
  if (out instanceof type.errors) throw new GitHubApiError(`Unexpected open pulls shape from GitHub: ${out.summary}`, 200);
  const { pageInfo, nodes } = out.repository.pullRequests;
  return {
    pulls: nodes.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author?.login ?? null,
      authorType: p.author?.__typename ?? null,
      headRef: p.headRefName,
      baseRef: p.baseRefName,
      headSha: p.headRefOid,
      updatedAt: p.updatedAt,
      isDraft: p.isDraft,
    })),
    endCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
  };
}

/** Lists every open PR in a repo, newest update first. Pages are fetched one after another. */
export async function fetchOpenPulls(
  client: Pick<GitHubClient, "graphql">,
  repo: string,
  now: () => Date = () => new Date(),
): Promise<OpenPullsListing> {
  const fetchedAt = now().toISOString();
  const pulls: OpenPull[] = [];
  let after: string | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
    const result = await client.graphql<unknown>(OPEN_PULLS_QUERY, { ...splitRepo(repo), after }, { repo, workClass: "openPulls" });
    const page = parseOpenPullsPage(result.data);
    pulls.push(...page.pulls);
    after = page.endCursor;
  } while (after);
  return { repo, fetchedAt, pulls };
}
