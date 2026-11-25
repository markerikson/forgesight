import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import type { UserRepoConfig } from "../config/schema.ts";
import { repoConfig } from "./config.ts";
import { originRank } from "./origin.ts";
import {
  buildWorkstreams,
  stackContext,
  titlePrefixes,
  type Workstream,
  type WsOverride,
  type WsPull,
} from "./workstreams.ts";

const REPO = "o/r";
const NOW = new Date("2026-11-24T12:00:00Z");

function pr(number: number, fields: Partial<WsPull> = {}): WsPull {
  return {
    repo: REPO,
    number,
    title: `Change ${number}`,
    author: "alice",
    headRef: `b${number}`,
    baseRef: "main",
    isDraft: false,
    updatedAt: "2026-11-24T00:00:00Z",
    ...fields,
  };
}

function settings(user: UserRepoConfig = {}) {
  return repoConfig(resolveConfig({ repos: { [REPO]: user } }), REPO);
}

function build(
  pulls: WsPull[],
  opts: { overrides?: WsOverride[]; previous?: Workstream[]; config?: UserRepoConfig; now?: Date } = {},
): Workstream[] {
  const repo = settings(opts.config);
  return buildWorkstreams(pulls, {
    trunks: repo.trunks,
    overrides: opts.overrides ?? [],
    previous: opts.previous ?? [],
    config: repo.workstreams,
    now: opts.now ?? NOW,
  });
}

const key = (n: number) => `${REPO}#${n}`;
const numbers = (ws: Workstream | undefined) => ws?.members.map((k) => Number(k.split("#")[1]));
const shape = (list: Workstream[]) => list.map(numbers);

/** A chain: each PR is based on the previous PR's head branch. */
function chain(start: number, count: number, fields: Partial<WsPull> = {}, base = "main"): WsPull[] {
  return Array.from({ length: count }, (_, i) =>
    pr(start + i, { baseRef: i === 0 ? base : `b${start + i - 1}`, ...fields }),
  );
}

describe("stack edges", () => {
  test("a chain is one workstream in stack order", () => {
    const [ws, ...rest] = build(chain(1, 3).reverse());
    expect(rest).toEqual([]);
    expect(numbers(ws)).toEqual([1, 2, 3]);
    expect(ws?.signals).toEqual(["stack"]);
    expect(ws?.id).toBe(`${REPO}:ws:1`);
    expect(ws?.edges).toEqual([
      { child: key(2), parent: key(1) },
      { child: key(3), parent: key(2) },
    ]);
  });

  test("two open PRs with the same head branch give no edge", () => {
    const pulls = [pr(1, { headRef: "x" }), pr(2, { headRef: "x", author: "bob" }), pr(3, { baseRef: "x" })];
    expect(build(pulls)).toEqual([]);
  });

  test("an open PR wins a head branch over a closed one", () => {
    const pulls = [
      pr(1, { headRef: "x", closed: "closed", closedAt: "2026-11-20T00:00:00Z" }),
      pr(2, { headRef: "x" }),
      pr(3, { baseRef: "x" }),
    ];
    expect(shape(build(pulls))).toEqual([[2, 3]]);
  });

  test("PRs on a trunk are not stacked, even when a PR has the trunk as head", () => {
    const pulls = [pr(1, { headRef: "main", baseRef: "release" }), pr(2), pr(3)];
    expect(build(pulls)).toEqual([]);
  });

  test("a merged root keeps its open children together", () => {
    const pulls = chain(1, 3);
    pulls[0] = { ...pr(1), closed: "merged", closedAt: "2026-11-23T00:00:00Z" };
    const [ws] = build(pulls);
    expect(numbers(ws)).toEqual([1, 2, 3]);
    expect(ws?.closed).toBe(false);
    expect(ws?.closedAt).toBeNull();
  });

  test("a group with only closed PRs is closed at its latest close", () => {
    const pulls = [
      pr(1, { closed: "merged", closedAt: "2026-11-20T00:00:00Z" }),
      pr(2, { baseRef: "b1", closed: "merged", closedAt: "2026-11-21T00:00:00Z" }),
    ];
    const [ws] = build(pulls);
    expect(ws?.closed).toBe(true);
    expect(ws?.closedAt).toBe("2026-11-21T00:00:00Z");
  });
});

describe("cuts", () => {
  test("a parent matching cutBelow does not hold its children", () => {
    const pulls = [
      pr(1, { title: "[CI vehicle, never merge] try things" }),
      ...chain(2, 2, {}, "b1"),
      ...chain(4, 2, { author: "bob" }, "b1"),
    ];
    expect(shape(build(pulls))).toEqual([
      [2, 3],
      [4, 5],
    ]);
  });

  test("a fork into large subtrees splits them", () => {
    const pulls = [pr(1), ...chain(2, 3, {}, "b1"), ...chain(5, 3, {}, "b1"), pr(8, { baseRef: "b1" })];
    // The root keeps the small branch; the two large ones stand alone.
    expect(shape(build(pulls, { config: { workstreams: { forkMinSize: 3 } } }))).toEqual([
      [1, 8],
      [2, 3, 4],
      [5, 6, 7],
    ]);
    expect(shape(build(pulls))).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
  });

  test("one large subtree under a parent is not a fork", () => {
    const pulls = [pr(1), ...chain(2, 3, {}, "b1"), pr(5, { baseRef: "b1" })];
    expect(shape(build(pulls, { config: { workstreams: { forkMinSize: 3 } } }))).toEqual([[1, 2, 3, 4, 5]]);
  });

  test("a cutBelow parent with a single child stays with it", () => {
    const pulls = [pr(1, { title: "[never merge] Cache: base" }), ...chain(2, 2, { title: "Cache: part" }, "b1")];
    expect(shape(build(pulls))).toEqual([[1, 2, 3]]);
  });

  test("a leaf on a shared branch whose title shares no prefix with the stack is cut", () => {
    const pulls = [
      pr(1, { title: "Cache: base" }),
      ...chain(2, 2, { title: "Cache: part" }, "b1"),
      pr(4, { title: "Runtime: unrelated fix", baseRef: "b1" }),
      pr(5, { title: "Cache: leaf", baseRef: "b1" }),
    ];
    expect(shape(build(pulls))).toEqual([[1, 2, 3, 5]]);
  });

  test("a topic fork needs siblings and a titled stack", () => {
    const only = [pr(1, { title: "Cache: base" }), pr(2, { title: "Runtime: next step", baseRef: "b1" })];
    expect(shape(build(only))).toEqual([[1, 2]]);
    const untitled = [pr(1), pr(2, { title: "Runtime: a", baseRef: "b1" }), pr(3, { baseRef: "b1" })];
    expect(shape(build(untitled))).toEqual([[1, 2, 3]]);
  });
});

describe("shared base and config groups", () => {
  test("PRs on a non-trunk base with no PR for it form a group", () => {
    const pulls = [pr(1, { baseRef: "feature/x" }), pr(2, { baseRef: "feature/x", author: "bob" }), pr(3)];
    const [ws, ...rest] = build(pulls);
    expect(rest).toEqual([]);
    expect(numbers(ws)).toEqual([1, 2]);
    expect(ws?.signals).toEqual(["sharedBase"]);
  });

  test("a configured trunk list replaces the default", () => {
    const pulls = [pr(1, { baseRef: "develop" }), pr(2, { baseRef: "develop" })];
    expect(shape(build(pulls))).toEqual([[1, 2]]);
    expect(build(pulls, { config: { trunks: ["develop"] } })).toEqual([]);
  });

  test("config rules join matching PRs and their stacks under the rule name", () => {
    const config: UserRepoConfig = {
      workstreams: { groups: [{ name: "Recording cases", titles: ["^recording\\b"], authors: ["alice"] }] },
    };
    const pulls = [
      pr(1, { title: "recording: case one" }),
      pr(2, { title: "Recording: case two" }),
      pr(3, { title: "Recording: case three", author: "bob" }),
      pr(4, { title: "follow-up", baseRef: "b2" }),
    ];
    const [ws, ...rest] = build(pulls, { config });
    expect(rest).toEqual([]);
    expect(numbers(ws)).toEqual([1, 2, 4]);
    expect(ws?.name).toBe("Recording cases");
    expect(ws?.nameSource).toBe("config");
    expect(ws?.signals).toEqual(["stack", "config"]);
  });

  test("a config rule can match head branches", () => {
    const config: UserRepoConfig = { workstreams: { groups: [{ name: "Deps", branches: ["^deps/"] }] } };
    const pulls = [pr(1, { headRef: "deps/a" }), pr(2, { headRef: "deps/b", author: "bob" })];
    expect(shape(build(pulls, { config }))).toEqual([[1, 2]]);
  });
});

describe("title prefixes", () => {
  test("prefixes come from brackets, colons, and identifier first words", () => {
    const config = settings().workstreams;
    expect(titlePrefixes("[Branch cache] S1: keys", config).map((p) => p.key)).toEqual(["branch cache", "s1"]);
    expect(titlePrefixes("🧪 DependencyGraph: view", config).map((p) => p.display)).toEqual(["DependencyGraph"]);
    expect(titlePrefixes("pair-stitch wiring", config).map((p) => p.key)).toEqual(["pair-stitch"]);
    expect(titlePrefixes("Plain words here", config)).toEqual([]);
  });

  test("generic prefixes, tickets, and cutBelow brackets are dropped", () => {
    const config = settings({ workstreams: { genericPrefixes: ["Hotfix"] } }).workstreams;
    for (const title of ["fix: a", "feat(api): b", "ENG-123: c", "#42: d", "Hotfix: e", "[DRAFT, never merge] f"]) {
      expect(titlePrefixes(title, config)).toEqual([]);
    }
  });

  test("same author and prefix join singles", () => {
    const pulls = [pr(1, { title: "Cache: one" }), pr(2, { title: "cache: two" }), pr(3, { title: "Cache: three", author: "bob" })];
    const [ws, ...rest] = build(pulls);
    expect(rest).toEqual([]);
    expect(numbers(ws)).toEqual([1, 2]);
    expect(ws?.signals).toEqual(["titlePrefix"]);
    expect(ws?.name).toBe("Cache");
    expect(ws?.nameSource).toBe("prefix");
    expect(ws?.prefix).toBe("cache");
  });

  test("generic prefixes do not join", () => {
    expect(build([pr(1, { title: "fix: one" }), pr(2, { title: "fix: two" })])).toEqual([]);
  });

  test("a prefix attaches a single to a stack", () => {
    const pulls = [...chain(1, 2, { title: "Cache: part" }), pr(3, { title: "Cache: loose end" })];
    const [ws] = build(pulls);
    expect(numbers(ws)).toEqual([1, 2, 3]);
    expect(ws?.signals).toEqual(["stack", "titlePrefix"]);
  });

  test("a prefix never joins two stacks, and is then generic for that author", () => {
    const pulls = [
      ...chain(1, 2, { title: "Cache: a" }),
      ...chain(3, 2, { title: "Cache: b" }, "main"),
      pr(5, { title: "Cache: c" }),
    ];
    expect(shape(build(pulls))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("title aliases map spellings to one prefix", () => {
    const config = settings({
      workstreams: { titleAliases: [{ match: "^(?:cg|CallGraph)\\b", replace: "CallGraph" }] },
    }).workstreams;
    expect(titlePrefixes("CG links: one", config).map((p) => p.display)).toEqual(["CallGraph links"]);
    expect(titlePrefixes("callgraph: two", config).map((p) => p.key)).toEqual(["callgraph"]);
    const pulls = [pr(1, { title: "CG: one" }), pr(2, { title: "CallGraph: two" })];
    expect(shape(build(pulls))).toEqual([]);
    expect(
      shape(build(pulls, { config: { workstreams: { titleAliases: [{ match: "^cg$", replace: "CallGraph" }] } } })),
    ).toEqual([[1, 2]]);
  });

  test("the same title by the same author joins, even when the prefix is generic for them", () => {
    const pulls = [
      ...chain(1, 2, { title: "Cache: a" }),
      ...chain(3, 2, { title: "Cache: b" }),
      pr(5, { title: "Cache: drop the old key table", closed: "closed", closedAt: "2026-11-23T00:00:00Z" }),
      pr(6, { title: "[never merge] Cache: drop the old key table" }),
      pr(7, { title: "Cache: drop the old key table", author: "bob" }),
    ];
    expect(shape(build(pulls))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  test("bots are never joined by prefix", () => {
    const pulls = [
      pr(1, { title: "build(deps): bump a", author: "dependabot", authorType: "Bot" }),
      pr(2, { title: "Bump: a", author: "renovate[bot]" }),
      pr(3, { title: "Bump: b", author: "renovate[bot]" }),
      pr(4, { title: "Bump: c", author: "helper" }),
      pr(5, { title: "Bump: d", author: "helper" }),
    ];
    expect(build(pulls, { config: { workstreams: { botAuthors: ["Helper"] } } })).toEqual([]);
  });
});

describe("IDs across rebuilds", () => {
  test("a rebuild with the same PRs keeps IDs", () => {
    const pulls = [...chain(1, 3), ...chain(10, 2, { author: "bob" })];
    const first = build(pulls);
    expect(build(pulls, { previous: first }).map((ws) => ws.id)).toEqual(first.map((ws) => ws.id));
  });

  test("retargeting after the root merges keeps the ID", () => {
    const first = build(chain(1, 3));
    const after = [
      { ...pr(1), closed: "merged" as const, closedAt: "2026-11-24T00:00:00Z" },
      pr(2),
      pr(3, { baseRef: "b2" }),
    ];
    const [ws] = build(after, { previous: first });
    expect(numbers(ws)).toEqual([2, 3]);
    expect(ws?.id).toBe(`${REPO}:ws:1`);
  });

  test("a new stack with a recently closed group's prefix takes its ID", () => {
    const closed = chain(1, 2, { title: "Cache: v1", closed: "closed", closedAt: "2026-11-20T00:00:00Z" });
    const first = build(closed);
    expect(first[0]?.closed).toBe(true);

    const reopened = chain(5, 2, { title: "Cache: v2" });
    const [ws] = build(reopened, { previous: first });
    expect(numbers(ws)).toEqual([5, 6]);
    expect(ws?.id).toBe(`${REPO}:ws:1`);

    const late = build(reopened, { previous: first, now: new Date("2026-12-20T00:00:00Z") });
    expect(late[0]?.id).toBe(`${REPO}:ws:5`);
  });

  test("a reopened stack merges into its closed predecessor while both are listed", () => {
    const closed = chain(1, 2, { title: "Cache: v1", closed: "closed", closedAt: "2026-11-20T00:00:00Z" });
    const first = build(closed);
    const reopened = [...closed, ...chain(5, 2, { title: "Cache: v2" })];
    const result = build(reopened, { previous: first });
    expect(shape(result)).toEqual([[1, 2, 5, 6]]);
    expect(result[0]?.id).toBe(`${REPO}:ws:1`);
    expect(result[0]?.closed).toBe(false);
    const again = build(reopened, { previous: result });
    expect(shape(again)).toEqual([[1, 2, 5, 6]]);
    expect(again[0]?.id).toBe(`${REPO}:ws:1`);
  });

  test("a merged reopened stack keeps its ID once the closed predecessor leaves the listing", () => {
    const closed = chain(1, 2, { title: "Cache: v1", closed: "closed", closedAt: "2026-11-20T00:00:00Z" });
    const open = chain(5, 2, { title: "Cache: v2" });
    const merged = build([...closed, ...open], { previous: build(closed) });
    const later = build(open, { previous: merged });
    expect(shape(later)).toEqual([[5, 6]]);
    expect(later[0]?.id).toBe(`${REPO}:ws:1`);
  });

  test("a new group does not reuse an ID that is taken", () => {
    const first = build(chain(1, 2));
    const pulls = [...chain(1, 2), pr(3, { baseRef: "feature/y" }), pr(4, { baseRef: "feature/y" })];
    const ids = build(pulls, { previous: first }).map((ws) => ws.id);
    expect(ids).toEqual([`${REPO}:ws:1`, `${REPO}:ws:3`]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("manual overrides", () => {
  const pulls = [...chain(1, 3), ...chain(10, 2, { author: "bob" }), pr(20)];

  test("merge, remove, and rename apply on every rebuild", () => {
    const overrides: WsOverride[] = [
      { kind: "merge", keys: [key(3), key(20)] },
      { kind: "remove", key: key(2) },
      { kind: "merge", keys: [key(10), key(11)] },
      { kind: "rename", id: `${REPO}:ws:10`, name: "Bob's work" },
    ];
    const first = build(pulls, { overrides });
    expect(shape(first)).toEqual([
      [1, 3, 20],
      [10, 11],
    ]);
    expect(first[0]?.signals).toContain("manual");
    expect(first[1]?.name).toBe("Bob's work");
    expect(first[1]?.nameSource).toBe("manual");

    const again = build(pulls, { overrides, previous: first });
    expect(again).toEqual(first);
  });

  test("removing a PR leaves a lone member out", () => {
    const result = build(chain(1, 2), { overrides: [{ kind: "remove", key: key(2) }] });
    expect(result).toEqual([]);
  });

  test("overrides naming unknown PRs are ignored", () => {
    const overrides: WsOverride[] = [
      { kind: "merge", keys: [key(1), key(99)] },
      { kind: "remove", key: key(98) },
      { kind: "rename", id: "nope", name: "x" },
    ];
    expect(shape(build(pulls, { overrides }))).toEqual(shape(build(pulls)));
  });
});

describe("stackContext", () => {
  test("reports parent, children, and position", () => {
    const pulls = [...chain(1, 3), pr(4, { baseRef: "b1" })];
    const [ws] = build(pulls);
    if (!ws) throw new Error("no workstream");
    expect(stackContext(ws, key(2))).toEqual({
      workstreamId: ws.id,
      parent: key(1),
      children: [key(3)],
      position: 2,
      size: 4,
    });
    expect(stackContext(ws, key(1))?.children).toEqual([key(2), key(4)]);
    expect(stackContext(ws, key(1))?.parent).toBeNull();
    expect(stackContext(ws, key(99))).toBeNull();
  });
});

test("originRank orders thread over stack over open-list", () => {
  expect(originRank("thread")).toBeGreaterThan(originRank("stack"));
  expect(originRank("stack")).toBeGreaterThan(originRank("open-list"));
});
