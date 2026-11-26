import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import type { Config } from "../core/config.ts";
import { Governor, MemoryApiCallLog } from "../github/budget.ts";
import { GitHubApiError } from "../github/errors.ts";
import { FakeGitHubClient } from "../github/fake.ts";
import type { Compare } from "../github/types.ts";
import { verdictsFor } from "../store/push-verdicts.ts";
import { memoryDb } from "../store/test-db.ts";
import { changesAfter } from "../store/views.ts";
import { backoffMs, MAX_ATTEMPTS, rebaseDetectorJob } from "./rebase-detector.ts";
import type { JobContext, Logger } from "./scheduler.ts";

const START = new Date("2026-11-24T12:00:00.000Z");
const REPO = "octo/repo";
const KEY = `${REPO}#1`;
const quietLog: Logger = { info() {}, warn() {}, error() {} };

interface VerdictRow {
  verdict: string;
  reason: string | null;
  attempts: number;
  next_attempt_at: string | null;
  base_before: string | null;
  base_after: string | null;
}

let db: Database;
let now: Date;
let gh: FakeGitHubClient;

const clock = () => now;

function makeConfig(overrides: { enabled?: boolean; view?: "overview" | "triage" } = {}): Config {
  return resolveConfig({
    me: "me",
    repos: { [REPO]: { view: overrides.view ?? "overview" } },
    rebase: { enabled: overrides.enabled ?? true },
  });
}

function makeCtx(config = makeConfig(), governor?: Governor): JobContext {
  return {
    db,
    gh,
    governor: governor ?? new Governor(new MemoryApiCallLog(), config.budget, clock),
    config,
    clock,
    log: quietLog,
  };
}

function seedSubject(baseRef: string, state = "OPEN"): void {
  db.query(
    `INSERT INTO subjects (subject_key, repo, number, kind, origin, state, author, base_ref, raw_json)
     VALUES (?, ?, 1, 'pr', 'open-list', ?, 'someone', ?, '{}')`,
  ).run(KEY, REPO, state, baseRef);
}

function seedItem(nodeId: string, typename: string, createdAt: string, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO timeline_items (node_id, subject_key, typename, created_at, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(nodeId, KEY, typename, createdAt, JSON.stringify({ __typename: typename, ...raw }), START.toISOString());
}

function seedPush(id: string, at: string, before: string, after: string): void {
  seedItem(id, "HeadRefForcePushedEvent", at, { beforeCommit: { oid: before }, afterCommit: { oid: after } });
}

function compare(mergeBaseSha: string, patch: string, files = 1): Compare {
  return {
    status: "ahead",
    aheadBy: 1,
    behindBy: 0,
    mergeBaseSha,
    commitShas: ["c"],
    totalCommits: 1,
    files: Array.from({ length: files }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch,
      previousFilename: null,
      sha: null,
    })),
    raw: {},
  };
}

function row(id = "P1"): VerdictRow | null {
  return db
    .query<VerdictRow, [string]>(
      "SELECT verdict, reason, attempts, next_attempt_at, base_before, base_after FROM push_verdicts WHERE push_node_id = ?",
    )
    .get(id);
}

beforeEach(() => {
  db = memoryDb();
  now = START;
  gh = new FakeGitHubClient(clock);
});

describe("rebaseDetectorJob", () => {
  test("marks a push that only moved onto a newer trunk as rebase_only", async () => {
    seedSubject("master");
    seedPush("P1", "2026-11-24T10:00:00Z", "aaa", "bbb");
    gh.compares.set(`${REPO}:master...aaa`, compare("base1", "@@ -1 +1 @@\n-x\n+y"));
    gh.compares.set(`${REPO}:master...bbb`, compare("base2", "@@ -5 +5 @@\n-x\n+y"));

    expect(await rebaseDetectorJob.run(makeCtx())).toBe("worked");
    expect(row()).toMatchObject({ verdict: "rebase_only", base_before: "master", base_after: "master", attempts: 1 });
    expect(verdictsFor(db, KEY).get("bbb")?.verdict).toBe("rebase_only");
    expect(changesAfter(db, 0)).toEqual([expect.objectContaining({ kind: "raw", subjectKey: KEY })]);
    expect(await rebaseDetectorJob.run(makeCtx())).toBe("idle");
  });

  test("marks a push with a different patch as changed", async () => {
    seedSubject("master");
    seedPush("P1", "2026-11-24T10:00:00Z", "aaa", "bbb");
    gh.compares.set(`${REPO}:master...aaa`, compare("base1", "-x\n+y"));
    gh.compares.set(`${REPO}:master...bbb`, compare("base1", "-x\n+z"));

    await rebaseDetectorJob.run(makeCtx());
    expect(row()).toMatchObject({ verdict: "changed", reason: "1 file differs" });
  });

  test("falls back to a trunk when the base branch is gone", async () => {
    seedSubject("feature/parent");
    seedPush("P1", "2026-11-24T10:00:00Z", "aaa", "bbb");
    gh.compares.set(`${REPO}:master...aaa`, compare("base1", "-x\n+y"));
    gh.compares.set(`${REPO}:master...bbb`, compare("base1", "-x\n+y"));

    await rebaseDetectorJob.run(makeCtx());
    expect(row()).toMatchObject({
      verdict: "noop",
      reason: "ref 404 -> master; ref 404 -> master; patches equal, same base",
      base_before: "master",
      base_after: "master",
    });
  });

  test("marks a push unknown when its commits are gone", async () => {
    seedSubject("master");
    seedPush("P1", "2026-11-24T10:00:00Z", "aaa", "bbb");

    await rebaseDetectorJob.run(makeCtx());
    expect(row()).toMatchObject({ verdict: "unknown", reason: "not found" });
  });

  test("defers server errors with backoff, then gives up", async () => {
    seedSubject("master");
    seedPush("P1", "2026-11-24T10:00:00Z", "aaa", "bbb");

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      gh.nextError = new GitHubApiError("boom", 502);
      // oxlint-disable-next-line no-await-in-loop -- each run depends on the previous one
      expect(await rebaseDetectorJob.run(makeCtx())).toBe("worked");
      const r = row();
      expect(r).toMatchObject({ verdict: "pending", reason: "HTTP 502", attempts: attempt });
      expect(r?.next_attempt_at).toBe(new Date(now.getTime() + backoffMs(attempt)).toISOString());
      // oxlint-disable-next-line no-await-in-loop -- each run depends on the previous one
      expect(await rebaseDetectorJob.run(makeCtx())).toBe("idle");
      now = new Date(now.getTime() + backoffMs(attempt));
    }
    gh.nextError = new GitHubApiError("boom", 502);
    await rebaseDetectorJob.run(makeCtx());
    expect(row()).toMatchObject({ verdict: "unknown", reason: "HTTP 502", attempts: MAX_ATTEMPTS });
  });

  test("queues pushes but spends nothing when the budget disallows rebase work", async () => {
    seedSubject("master");
    seedPush("P1", "2026-11-24T10:00:00Z", "aaa", "bbb");
    const config = makeConfig();
    const governor = new Governor(new MemoryApiCallLog(), { ...config.budget, restPerHour: 0 }, clock);

    await rebaseDetectorJob.run(makeCtx(config, governor));
    expect(row()?.verdict).toBe("pending");
    expect(gh.calls).toEqual([]);
  });

  test("does nothing when rebase detection is off", async () => {
    seedSubject("master");
    seedPush("P1", "2026-11-24T10:00:00Z", "aaa", "bbb");

    expect(await rebaseDetectorJob.run(makeCtx(makeConfig({ enabled: false })))).toBe("idle");
    expect(row()).toBeNull();
  });

  test("skips triage repos and closed PRs", async () => {
    seedSubject("master", "CLOSED");
    seedPush("P1", "2026-11-24T10:00:00Z", "aaa", "bbb");
    expect(await rebaseDetectorJob.run(makeCtx())).toBe("idle");

    db.query("UPDATE subjects SET state = 'OPEN'").run();
    expect(await rebaseDetectorJob.run(makeCtx(makeConfig({ view: "triage" })))).toBe("idle");
    expect(row()).toBeNull();
  });
});
