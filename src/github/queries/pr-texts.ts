import { type } from "arktype";
import { GitHubApiError } from "../errors.ts";
import type { GitHubClient } from "../types.ts";
import { splitRepo } from "./subject-batch.ts";

export const PR_TEXTS_MAX = 50;
/** Descriptions are clipped to this many characters before storing. */
export const PR_BODY_LIMIT = 4096;

export interface PrTextResult {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
}

export interface PrTextsResponse {
  texts: PrTextResult[];
  /** Requested numbers GitHub returned no pull request for. */
  missing: number[];
}

export function buildPrTextsQuery(numbers: readonly number[]): string {
  const fields = numbers
    .map((n, i) => `    p${i}: pullRequest(number: ${n}) { number title bodyText updatedAt isDraft state }`)
    .join("\n");
  return `query PrTexts($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
${fields}
  }
}`;
}

const prText = type({
  number: "number",
  title: "string",
  bodyText: "string",
  updatedAt: "string",
  isDraft: "boolean",
  state: "'OPEN' | 'CLOSED' | 'MERGED'",
});

const prTextsData = type({
  repository: type({ "[string]": prText.or("null") }).or("null"),
});

export function clipBody(body: string): string {
  return body.length <= PR_BODY_LIMIT ? body : body.slice(0, PR_BODY_LIMIT);
}

export function parsePrTexts(raw: unknown, numbers: readonly number[]): PrTextsResponse {
  const out = prTextsData(raw);
  if (out instanceof type.errors) {
    throw new GitHubApiError(`Unexpected PR texts shape from GitHub: ${out.summary}`, 200);
  }
  const texts: PrTextResult[] = [];
  const missing: number[] = [];
  numbers.forEach((n, i) => {
    const p = out.repository?.[`p${i}`];
    if (!p) {
      missing.push(n);
      return;
    }
    texts.push({
      number: p.number,
      title: p.title,
      body: clipBody(p.bodyText),
      updatedAt: p.updatedAt,
      isDraft: p.isDraft,
      state: p.state,
    });
  });
  return { texts, missing };
}

/** Fetches titles and plain-text descriptions for up to `PR_TEXTS_MAX` PRs in one repo. */
export async function fetchPrTexts(
  client: Pick<GitHubClient, "graphql">,
  repo: string,
  numbers: readonly number[],
): Promise<PrTextsResponse> {
  if (numbers.length === 0) return { texts: [], missing: [] };
  if (numbers.length > PR_TEXTS_MAX) {
    throw new Error(`fetchPrTexts takes at most ${PR_TEXTS_MAX} PRs, got ${numbers.length}`);
  }
  const result = await client.graphql<unknown>(buildPrTextsQuery(numbers), splitRepo(repo), {
    repo,
    workClass: "openPulls",
  });
  return parsePrTexts(result.data, numbers);
}
