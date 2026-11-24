import { describe, expect, test } from "bun:test";
import { DIFFLOUPE_MARKER, initialBatchState, REPLAY_QA_MARKER } from "../core/enrich-plan.ts";
import { GqlError, RateLimitedError } from "../github/errors.ts";
import { FakeGitHubClient } from "../github/fake.ts";
import type { GqlErrorEntry, GqlResult } from "../github/types.ts";
import { clearDirty, ensureSubjects, getSubject, markDirty } from "../store/subjects.ts";
import { memoryDb } from "../store/test-db.ts";
import { stickiesFor, stickyNodeIds, timelineFor } from "../store/timeline.ts";
import { applyEnrichOutcomes, type EnrichBatchInput, enrichRepoBatch, enrichSubjectFor } from "./enrich-batch.ts";

const REPO = "octo/repo";
const NOW = new Date("2026-11-23T12:00:00Z");
const clock = () => NOW;
const markers = [REPLAY_QA_MARKER, DIFFLOUPE_MARKER];

interface Item {
  __typename: string;
  id: string;
  createdAt?: string;
  [key: string]: unknown;
}

function comment(id: string, body: string, login = "bob", typename = "User"): Item {
  return {
    __typename: "IssueComment",
    id,
    createdAt: "2026-11-23T10:00:00Z",
    body,
    lastEditedAt: null,
    author: { login, __typename: typename },
  };
}

function event(id: string): Item {
  return { __typename: "LabeledEvent", id, createdAt: "2026-11-23T09:00:00Z" };
}

function pr(number: number, items: Item[], page?: { hasNextPage: boolean; endCursor: string | null }) {
  return {
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    state: "OPEN",
    author: { login: "alice", __typename: "User" },
    baseRefName: "main",
    headRefName: `b${number}`,
    baseRefOid: "base",
    headRefOid: `head${number}`,
    updatedAt: "2026-11-23T11:00:00Z",
    reviewThreads: { nodes: [] },
    timelineItems: { pageInfo: page ?? { hasNextPage: false, endCursor: null }, nodes: items },
  };
}

function issue(number: number, items: Item[]) {
  return {
    id: `I_${number}`,
    number,
    state: "OPEN",
    author: null,
    updatedAt: "2026-11-23T11:00:00Z",
    timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: items },
  };
}

function ok(data: unknown, extra: Partial<GqlResult<unknown>> = {}): GqlResult<unknown> {
  return { data, cost: 1, remaining: 4000, resetAt: NOW, gatewayErrors: 0, ...extra };
}

/** Subject numbers asked for by alias, in order. */
function requested(query: string): Array<{ alias: string; number: number; after: string | null }> {
  return [...query.matchAll(/(s\d+): (?:pullRequest|issue)\(number: (\d+)\) \{([^\n]*)/g)].map((m) => ({
    alias: m[1] ?? "",
    number: Number(m[2]),
    after: /after: "([^"]+)"/.exec(m[3] ?? "")?.[1] ?? null,
  }));
}

function setup(keys: Array<[number, "pr" | "issue" | "other"]>) {
  const db = memoryDb();
  ensureSubjects(
    db,
    keys.map(([number, kind]) => ({ subjectKey: `${REPO}#${number}`, repo: REPO, number, kind, origin: "thread" })),
  );
  markDirty(
    db,
    keys.map(([n]) => `${REPO}#${n}`),
    NOW.toISOString(),
  );
  return db;
}

function input(numbers: Array<[number, "pr" | "issue"]>, overrides: Partial<EnrichBatchInput> = {}): EnrichBatchInput {
  return {
    repo: REPO,
    mode: "full",
    subjects: numbers.map(([number, kind]) => ({ subjectKey: `${REPO}#${number}`, kind, number, since: null })),
    stickyIds: new Map(),
    state: initialBatchState(10),
    maxSize: 10,
    markers,
    workClass: "enrich",
    ...overrides,
  };
}

describe("enrichRepoBatch", () => {
  test("saves a mixed batch and clears dirty", async () => {
    const db = setup([
      [1, "pr"],
      [2, "issue"],
    ]);
    const gh = new FakeGitHubClient(clock);
    gh.graphqlHandler = (query) => {
      const [a, b] = requested(query);
      expect(a?.number).toBe(1);
      expect(b?.number).toBe(2);
      return ok({
        repository: { s0: pr(1, [comment("IC_1", "hi"), event("LE_1")]), s1: issue(2, [event("LE_2")]) },
        stickies: [],
      });
    };
    const out = await enrichRepoBatch(
      { graphql: gh.graphql.bind(gh), clock },
      input([
        [1, "pr"],
        [2, "issue"],
      ]),
    );
    expect(out.queries).toBe(1);
    expect(out.cost).toBe(1);
    expect(out.state).toEqual({ size: 10, successes: 1, reduced: false });
    expect(gh.calls[0]).toMatchObject({ method: "graphql", opts: { repo: REPO, workClass: "enrich" } });
    applyEnrichOutcomes(db, out.outcomes, NOW.toISOString());

    const s1 = getSubject(db, `${REPO}#1`);
    expect(s1).toMatchObject({ dirtyAt: null, headSha: "head1", timelineSyncedUntil: NOW.toISOString() });
    expect(timelineFor(db, `${REPO}#1`).map((i) => i.nodeId)).toEqual(["LE_1", "IC_1"]);
    expect(getSubject(db, `${REPO}#2`)).toMatchObject({ dirtyAt: null, nodeId: "I_2", state: "OPEN" });
  });

  test("partial errors fail only their subject; NOT_FOUND clears it from the queue", async () => {
    const db = setup([
      [1, "pr"],
      [2, "pr"],
      [3, "pr"],
    ]);
    const gh = new FakeGitHubClient(clock);
    const errors: GqlErrorEntry[] = [
      { message: "Could not resolve", type: "NOT_FOUND", path: ["repository", "s1"] },
      { message: "Something broke", path: ["repository", "s2"] },
    ];
    gh.graphqlHandler = () => ok({ repository: { s0: pr(1, []), s1: null, s2: null }, stickies: [] }, { errors });
    const out = await enrichRepoBatch(
      { graphql: gh.graphql.bind(gh), clock },
      input([
        [1, "pr"],
        [2, "pr"],
        [3, "pr"],
      ]),
    );
    expect(out.outcomes.map((o) => o.kind)).toEqual(["ok", "notFound", "error"]);
    applyEnrichOutcomes(db, out.outcomes, NOW.toISOString());
    expect(getSubject(db, `${REPO}#1`)).toMatchObject({ dirtyAt: null, enrichError: null });
    expect(getSubject(db, `${REPO}#2`)).toMatchObject({ dirtyAt: null, enrichError: "not_found" });
    expect(getSubject(db, `${REPO}#3`)).toMatchObject({
      dirtyAt: NOW.toISOString(),
      enrichError: "Something broke",
      enrichAttempts: 1,
    });
  });

  test("a subject that fails to parse gets an error outcome", async () => {
    const gh = new FakeGitHubClient(clock);
    gh.graphqlHandler = () =>
      ok({ repository: { s0: { ...pr(1, []), state: "WEIRD" }, s1: pr(2, []) }, stickies: [] });
    const out = await enrichRepoBatch(
      { graphql: gh.graphql.bind(gh), clock },
      input([
        [1, "pr"],
        [2, "pr"],
      ]),
    );
    expect(out.outcomes.map((o) => o.kind)).toEqual(["error", "ok"]);
  });

  test("fetches the rest of a long timeline alone with the cursor", async () => {
    const gh = new FakeGitHubClient(clock);
    gh.graphqlHandler = (query) => {
      const asked = requested(query);
      if (asked[0]?.after === "c1") {
        expect(asked).toHaveLength(1);
        expect(query).not.toContain("...PrCore");
        return ok({
          repository: {
            s0: { timelineItems: { pageInfo: { hasNextPage: true, endCursor: "c2" }, nodes: [event("LE_2"), event("LE_1")] } },
          },
          stickies: [],
        });
      }
      if (asked[0]?.after === "c2") {
        return ok({
          repository: { s0: { timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [event("LE_3")] } } },
          stickies: [],
        });
      }
      return ok({
        repository: { s0: pr(1, [event("LE_1")], { hasNextPage: true, endCursor: "c1" }), s1: pr(2, [event("LE_9")]) },
        stickies: [],
      });
    };
    const out = await enrichRepoBatch(
      { graphql: gh.graphql.bind(gh), clock },
      input([
        [1, "pr"],
        [2, "pr"],
      ]),
    );
    expect(out.queries).toBe(3);
    const first = out.outcomes[0];
    expect(first?.kind).toBe("ok");
    if (first?.kind === "ok") expect(first.result.timelineItems.map((i) => i.nodeId)).toEqual(["LE_1", "LE_2", "LE_3"]);
  });

  test("a failed follow-up page fails that subject only", async () => {
    const gh = new FakeGitHubClient(clock);
    gh.graphqlHandler = (query) => {
      if (requested(query)[0]?.after) throw new GqlError("502", "gateway", 502);
      return ok({
        repository: { s0: pr(1, [], { hasNextPage: true, endCursor: "c1" }), s1: pr(2, []) },
        stickies: [],
      });
    };
    const out = await enrichRepoBatch(
      { graphql: gh.graphql.bind(gh), clock },
      input([
        [1, "pr"],
        [2, "pr"],
      ]),
    );
    expect(out.outcomes.map((o) => o.kind)).toEqual(["error", "ok"]);
  });

  test("stores a new sticky version only when the body changes", async () => {
    const db = setup([[1, "pr"]]);
    const gh = new FakeGitHubClient(clock);
    const sticky = comment("IC_S", "summary v1\n<!-- replay-qa-bot -->", "replay-qa", "Bot");
    let stickyBody = sticky.body as string;
    const seenIds: unknown[] = [];
    gh.graphqlHandler = (_query, variables) => {
      seenIds.push(variables.stickyIds);
      const timeline = seenIds.length === 1 ? [sticky, comment("IC_H", "the bot adds `<!-- replay-qa-bot -->` to its comments")] : [];
      return ok({
        repository: { s0: pr(1, timeline) },
        stickies: (variables.stickyIds as string[]).map((id) => ({
          id,
          body: stickyBody,
          lastEditedAt: null,
          author: { login: "replay-qa", __typename: "Bot" },
        })),
      });
    };
    const run = async () => {
      const stickyIds = stickyNodeIds(db, [`${REPO}#1`]);
      const out = await enrichRepoBatch({ graphql: gh.graphql.bind(gh), clock }, input([[1, "pr"]], { stickyIds }));
      applyEnrichOutcomes(db, out.outcomes, NOW.toISOString());
    };

    await run();
    expect(stickiesFor(db, `${REPO}#1`).map((s) => s.body)).toEqual([stickyBody]);
    await run();
    expect(seenIds[1]).toEqual(["IC_S"]);
    expect(stickiesFor(db, `${REPO}#1`)).toHaveLength(1);
    stickyBody = "summary v2\n<!-- replay-qa-bot -->";
    await run();
    expect(stickiesFor(db, `${REPO}#1`).map((s) => s.body).sort()).toEqual(
      ["summary v1\n<!-- replay-qa-bot -->", "summary v2\n<!-- replay-qa-bot -->"].sort(),
    );
  });

  test("gateway errors halve the batch and retry", async () => {
    const gh = new FakeGitHubClient(clock);
    const sizes: number[] = [];
    gh.graphqlHandler = (query) => {
      const asked = requested(query);
      sizes.push(asked.length);
      if (asked.length > 2) throw new GqlError("502 Bad Gateway", "gateway", 502);
      return ok({
        repository: Object.fromEntries(asked.map((a) => [a.alias, pr(a.number, [])])),
        stickies: [],
      });
    };
    const out = await enrichRepoBatch(
      { graphql: gh.graphql.bind(gh), clock },
      input(
        [1, 2, 3, 4, 5].map((n) => [n, "pr"] as [number, "pr"]),
        { state: { size: 8, successes: 0, reduced: false } },
      ),
    );
    expect(sizes).toEqual([5, 4, 2, 2, 1]);
    expect(out.outcomes.every((o) => o.kind === "ok")).toBe(true);
    expect(out.state).toEqual({ size: 2, successes: 3, reduced: false });
  });

  test("a success that needed gateway retries still shrinks the batch", async () => {
    const gh = new FakeGitHubClient(clock);
    gh.graphqlHandler = () => ok({ repository: { s0: pr(1, []), s1: pr(2, []) }, stickies: [] }, { gatewayErrors: 2 });
    const out = await enrichRepoBatch(
      { graphql: gh.graphql.bind(gh), clock },
      input([
        [1, "pr"],
        [2, "pr"],
      ]),
    );
    expect(out.outcomes.map((o) => o.kind)).toEqual(["ok", "ok"]);
    expect(out.state.size).toBe(5);
  });

  test("at size 1, switches to reduced fields, then gives up on the subject", async () => {
    const gh = new FakeGitHubClient(clock);
    const shapes: string[] = [];
    gh.graphqlHandler = (query) => {
      const asked = requested(query);
      shapes.push(query.includes("contexts(") ? "full" : "reduced");
      if (asked[0]?.number === 1) throw new GqlError("timed out", "timeout", 0);
      return ok({ repository: { s0: pr(asked[0]?.number ?? 0, []) }, stickies: [] });
    };
    const out = await enrichRepoBatch(
      { graphql: gh.graphql.bind(gh), clock },
      input(
        [
          [1, "pr"],
          [2, "pr"],
        ],
        { state: { size: 1, successes: 0, reduced: false } },
      ),
    );
    expect(shapes).toEqual(["full", "reduced", "reduced"]);
    expect(out.outcomes).toEqual([
      { kind: "error", subjectKey: `${REPO}#1`, error: "timed out" },
      expect.objectContaining({ kind: "ok", subjectKey: `${REPO}#2` }),
    ]);
    expect(out.state).toEqual({ size: 1, successes: 1, reduced: true });
  });

  test("rate limits and query errors stop the run", async () => {
    const gh = new FakeGitHubClient(clock);
    gh.graphqlHandler = () => {
      throw new RateLimitedError("limited", null, false);
    };
    await expect(enrichRepoBatch({ graphql: gh.graphql.bind(gh), clock }, input([[1, "pr"]]))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    gh.graphqlHandler = () => {
      throw new GqlError("Field 'x' doesn't exist", "graphql", 200);
    };
    await expect(enrichRepoBatch({ graphql: gh.graphql.bind(gh), clock }, input([[1, "pr"]]))).rejects.toBeInstanceOf(
      GqlError,
    );
  });
});

describe("enrichSubjectFor", () => {
  test("skips other kinds and computes since", () => {
    const db = setup([
      [1, "pr"],
      [2, "other"],
    ]);
    const pr1 = getSubject(db, `${REPO}#1`);
    const other = getSubject(db, `${REPO}#2`);
    if (!pr1 || !other) throw new Error("missing subjects");
    expect(enrichSubjectFor(other, null, NOW)).toBeNull();
    expect(enrichSubjectFor(pr1, null, NOW)).toEqual({ subjectKey: `${REPO}#1`, kind: "pr", number: 1, since: null });
    expect(enrichSubjectFor({ ...pr1, timelineSyncedUntil: "2026-11-23T11:00:00.000Z" }, null, NOW)?.since).toBe(
      "2026-11-23T10:55:00.000Z",
    );
  });

  test("clearDirty drops subjects from the queue", () => {
    const db = setup([[2, "other"]]);
    clearDirty(db, [`${REPO}#2`]);
    expect(getSubject(db, `${REPO}#2`)?.dirtyAt).toBeNull();
  });
});
