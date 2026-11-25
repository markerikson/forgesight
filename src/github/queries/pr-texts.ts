import { type } from "arktype";
import { GitHubApiError } from "../errors.ts";
import type { GitHubClient, GqlErrorEntry } from "../types.ts";
import { errorsByAlias, splitRepo } from "./subject-batch.ts";

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
  /** Requested numbers GitHub says do not exist (NOT_FOUND). */
  missing: number[];
  /** Requested numbers that came back empty for another reason; worth asking again later. */
  failed: number[];
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

/** A NOT_FOUND error for the repository or for this alias, as opposed to a field inside it. */
function isNotFound(errors: GqlErrorEntry[]): boolean {
  return errors.some((e) => {
    if (e.type !== "NOT_FOUND") return false;
    const path = e.path ?? [];
    return path.length <= 2 && (path.length === 0 || path[0] === "repository");
  });
}

export function parsePrTexts(
  raw: unknown,
  numbers: readonly number[],
  errors?: GqlErrorEntry[],
): PrTextsResponse {
  const out = prTextsData(raw ?? { repository: null });
  if (out instanceof type.errors) {
    throw new GitHubApiError(`Unexpected PR texts shape from GitHub: ${out.summary}`, 200);
  }
  const byAlias = errorsByAlias(errors);
  const general = byAlias.get("") ?? [];
  const texts: PrTextResult[] = [];
  const missing: number[] = [];
  const failed: number[] = [];
  numbers.forEach((n, i) => {
    const alias = `p${i}`;
    const p = out.repository?.[alias];
    if (!p) {
      const aliasErrors = [...(byAlias.get(alias) ?? []), ...general];
      (isNotFound(aliasErrors) ? missing : failed).push(n);
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
  return { texts, missing, failed };
}

/** Fetches titles and plain-text descriptions for up to `PR_TEXTS_MAX` PRs in one repo. */
export async function fetchPrTexts(
  client: Pick<GitHubClient, "graphql">,
  repo: string,
  numbers: readonly number[],
): Promise<PrTextsResponse> {
  if (numbers.length === 0) return { texts: [], missing: [], failed: [] };
  if (numbers.length > PR_TEXTS_MAX) {
    throw new Error(`fetchPrTexts takes at most ${PR_TEXTS_MAX} PRs, got ${numbers.length}`);
  }
  const result = await client.graphql<unknown>(buildPrTextsQuery(numbers), splitRepo(repo), {
    repo,
    workClass: "openPulls",
  });
  return parsePrTexts(result.data, numbers, result.errors);
}
