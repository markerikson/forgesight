import { describe, expect, test } from "bun:test";
import { GitHubApiError } from "../errors.ts";
import { FakeGitHubClient } from "../fake.ts";
import {
  buildPrTextsQuery,
  fetchPrTexts,
  parsePrTexts,
  PR_BODY_LIMIT,
  PR_TEXTS_MAX,
} from "./pr-texts.ts";

const pr = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  bodyText: `Body of ${number}`,
  updatedAt: "2026-11-20T10:00:00Z",
  isDraft: false,
  state: "OPEN",
  ...overrides,
});

describe("buildPrTextsQuery", () => {
  test("aliases one pullRequest field per number", () => {
    const query = buildPrTextsQuery([12, 40]);
    expect(query).toContain("p0: pullRequest(number: 12)");
    expect(query).toContain("p1: pullRequest(number: 40)");
    expect(query).toContain("rateLimit { cost remaining resetAt }");
  });
});

describe("parsePrTexts", () => {
  test("maps aliases back to numbers and reports nulls as missing", () => {
    const raw = { repository: { p0: pr(12, { isDraft: true }), p1: null, p2: pr(41, { state: "MERGED" }) } };
    const { texts, missing } = parsePrTexts(raw, [12, 40, 41]);
    expect(missing).toEqual([40]);
    expect(texts).toEqual([
      { number: 12, title: "PR 12", body: "Body of 12", updatedAt: "2026-11-20T10:00:00Z", isDraft: true, state: "OPEN" },
      { number: 41, title: "PR 41", body: "Body of 41", updatedAt: "2026-11-20T10:00:00Z", isDraft: false, state: "MERGED" },
    ]);
  });

  test("clips long descriptions", () => {
    const raw = { repository: { p0: pr(1, { bodyText: "x".repeat(PR_BODY_LIMIT + 500) }) } };
    expect(parsePrTexts(raw, [1]).texts[0]?.body).toHaveLength(PR_BODY_LIMIT);
  });

  test("treats a missing repository as all missing", () => {
    expect(parsePrTexts({ repository: null }, [1, 2])).toEqual({ texts: [], missing: [1, 2] });
  });

  test("throws on an unexpected shape", () => {
    expect(() => parsePrTexts({ repository: { p0: { number: 1 } } }, [1])).toThrow(GitHubApiError);
  });
});

describe("fetchPrTexts", () => {
  test("sends one query with owner/name and the openPulls work class", async () => {
    const gh = new FakeGitHubClient();
    gh.graphqlHandler = () => ({
      data: { repository: { p0: pr(5), p1: pr(6) } },
      cost: 1,
      remaining: 4000,
      resetAt: new Date("2026-11-20T11:00:00Z"),
      gatewayErrors: 0,
    });
    const result = await fetchPrTexts(gh, "acme/app", [5, 6]);
    expect(result.texts.map((t) => t.number)).toEqual([5, 6]);
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toMatchObject({
      method: "graphql",
      variables: { owner: "acme", name: "app" },
      opts: { repo: "acme/app", workClass: "openPulls" },
    });
  });

  test("makes no call for an empty list and rejects oversized batches", async () => {
    const gh = new FakeGitHubClient();
    expect(await fetchPrTexts(gh, "acme/app", [])).toEqual({ texts: [], missing: [] });
    expect(gh.calls).toHaveLength(0);
    const tooMany = Array.from({ length: PR_TEXTS_MAX + 1 }, (_, i) => i + 1);
    await expect(fetchPrTexts(gh, "acme/app", tooMany)).rejects.toThrow();
  });
});
