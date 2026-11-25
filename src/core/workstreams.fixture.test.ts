import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../config/load.ts";
import type { UserRepoConfig } from "../config/schema.ts";
import { repoConfig } from "./config.ts";
import { buildWorkstreams, type Workstream, type WsPull } from "./workstreams.ts";

// Open PRs plus PRs closed in the previous 7 days from a real repository, anonymized:
// numbers, authors, branches and titles are replaced, keeping only what grouping reads.
const dir = join(import.meta.dir, "__workstream_fixtures__", "sample");

interface Case {
  repo: string;
  fetchedAt: string;
  config: UserRepoConfig;
}

const fixture: Case = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
const pulls: WsPull[] = JSON.parse(readFileSync(join(dir, "pulls.json"), "utf8"));
const repo = repoConfig(resolveConfig({ repos: { [fixture.repo]: fixture.config } }), fixture.repo);

function build(previous: Workstream[] = []): Workstream[] {
  return buildWorkstreams(pulls, {
    trunks: repo.trunks,
    overrides: [],
    previous,
    config: repo.workstreams,
    now: new Date(fixture.fetchedAt),
  });
}

const numbers = (ws: Workstream | undefined) => ws?.members.map((key) => Number(key.split("#")[1]));
const summarize = (list: Workstream[]) =>
  list.map((ws) => ({
    id: ws.id,
    name: ws.name,
    nameSource: ws.nameSource,
    signals: ws.signals,
    closed: ws.closed,
    members: numbers(ws),
  }));

const groups = build();
const containing = (number: number) => groups.find((ws) => numbers(ws)?.includes(number));

describe("workstreams on a repository snapshot", () => {
  test("matches the recorded grouping", () => {
    const actual = summarize(groups);
    const file = join(dir, "expected.json");
    if (process.env.UPDATE_FIXTURES || !existsSync(file)) {
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(JSON.parse(readFileSync(file, "utf8")));
  });

  test("a closed chain stays one closed group", () => {
    const ws = containing(478);
    expect(ws?.closed).toBe(true);
    expect(ws?.members.length).toBeGreaterThanOrEqual(6);
  });

  test("the config rule collects one author's PRs", () => {
    const ws = groups.find((g) => g.name === "Case work");
    expect(ws?.nameSource).toBe("config");
    expect(ws?.signals).toContain("config");
    expect(ws?.author).toBe("user8");
  });

  test("every PR is in at most one group", () => {
    const seen = new Set<string>();
    for (const ws of groups) {
      for (const key of ws.members) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  test("rebuilding with the previous result keeps every ID", () => {
    expect(build(groups).map((ws) => ws.id)).toEqual(groups.map((ws) => ws.id));
  });
});
