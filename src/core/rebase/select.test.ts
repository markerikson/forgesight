import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../../config/load.ts";
import type { TimelineItemRecord } from "../types.ts";
import { type BaseForPushInput, type HeadPush, baseForPush, needsVerdict, pushHistory } from "./select.ts";

const TRUNKS = ["master", "main"];

function head(id: string, at: string, before: string, after: string): HeadPush {
  return { id, at, before, after };
}

function input(overrides: Partial<BaseForPushInput> & { push: HeadPush }): BaseForPushInput {
  return { heads: [], baseForces: [], refChanges: [], baseRef: "master", trunks: TRUNKS, ...overrides };
}

describe("baseForPush", () => {
  test("a plain push onto trunk diffs both sides against the trunk name", () => {
    const push = head("p", "2026-11-20T10:00:00Z", "a", "b");
    expect(baseForPush(input({ heads: [push], push }))).toEqual({
      before: "master",
      after: "master",
      source: { before: "ref", after: "ref" },
    });
  });

  test("uses base pushes within 15 seconds of each side", () => {
    // A restack: the parent moved 2s after the previous head push and 1s before this one.
    const prev = head("p1", "2026-11-20T17:35:31Z", "x", "a201");
    const push = head("p2", "2026-11-20T17:36:54Z", "a201", "eff1");
    const result = baseForPush(
      input({
        heads: [prev, push],
        baseForces: [
          { at: "2026-11-20T17:35:33Z", before: "old", after: "5e71" },
          { at: "2026-11-20T17:36:53Z", before: "5e71", after: "fb07" },
        ],
        push,
        baseRef: "dominik/parent",
      }),
    );
    expect(result).toEqual({ before: "5e71", after: "fb07", source: { before: "basePush", after: "basePush" } });
  });

  test("falls back to the next base push's before commit", () => {
    const prev = head("p1", "2026-11-23T21:55:21Z", "x", "9e91");
    const push = head("p2", "2026-11-23T21:59:41Z", "9e91", "7694");
    const result = baseForPush(
      input({
        heads: [prev, push],
        baseForces: [{ at: "2026-11-23T21:59:40Z", before: "2e2b", after: "e554" }],
        push,
        baseRef: "dominik/parent",
      }),
    );
    expect(result).toEqual({ before: "2e2b", after: "e554", source: { before: "nextBasePush", after: "basePush" } });
  });

  test("uses the base ref in effect at the push, not the current one", () => {
    const push = head("p", "2026-11-24T16:56:42Z", "74b7", "7891");
    const result = baseForPush(
      input({
        heads: [push],
        refChanges: [
          { at: "2026-11-24T16:39:10Z", from: "dominik/origin-points" },
          { at: "2026-11-24T16:55:18Z", from: "dominik/view-param" },
          { at: "2026-11-24T17:51:22Z", from: "dominik/listed-cursor" },
        ],
        push,
        baseRef: "dominik/next-region",
      }),
    );
    expect(result).toEqual({
      before: "dominik/listed-cursor",
      after: "dominik/listed-cursor",
      source: { before: "ref", after: "ref" },
    });
  });

  test("a base push next to the previous head push wins even when the PR is now on trunk", () => {
    const prev = head("p1", "2026-11-20T18:31:33Z", "9567", "4e33");
    const push = head("p2", "2026-11-20T19:35:05Z", "4e33", "a7e6");
    const result = baseForPush(
      input({
        heads: [head("p0", "2026-11-20T18:21:01Z", "3bc5", "96d3"), prev, push],
        baseForces: [{ at: "2026-11-20T18:31:32Z", before: "c64b", after: "fd25" }],
        refChanges: [
          { at: "2026-11-20T18:21:03Z", from: "master" },
          { at: "2026-11-20T19:35:00Z", from: "dominik/parent" },
        ],
        push,
      }),
    );
    expect(result).toEqual({ before: "fd25", after: "master", source: { before: "basePush", after: "ref" } });
  });

  test("diffs against the parent ref name when no base push follows", () => {
    const prev = head("p1", "2026-11-23T21:21:28Z", "870a", "f9ea");
    const push = head("p2", "2026-11-24T01:13:14Z", "f9ea", "2108");
    const result = baseForPush(
      input({
        heads: [prev, push, head("p3", "2026-11-24T02:00:01Z", "2108", "zzzz")],
        baseForces: [
          { at: "2026-11-23T22:26:09Z", before: "1852", after: "8ee5" },
          { at: "2026-11-23T22:37:27Z", before: "8ee5", after: "d706" },
        ],
        refChanges: [{ at: "2026-11-24T01:13:52Z", from: "merikson/tenancy" }],
        push,
      }),
    );
    expect(result).toEqual({
      before: "1852",
      after: "merikson/tenancy",
      source: { before: "nextBasePush", after: "ref" },
    });
  });

  test("ignores base pushes made while the PR was on a different base", () => {
    const prev = head("p1", "2026-11-24T14:00:00Z", "x", "cd03");
    const push = head("p2", "2026-11-24T14:38:05Z", "cd03", "cfbb");
    const result = baseForPush(
      input({
        heads: [prev, push],
        baseForces: [{ at: "2026-11-24T15:19:26Z", before: "5fb3", after: "aff5" }],
        refChanges: [
          { at: "2026-11-24T14:51:51Z", from: "dominik/store-write" },
          { at: "2026-11-24T15:20:19Z", from: "dominik/value-path" },
        ],
        push,
        baseRef: "dominik/consume-gap",
      }),
    );
    expect(result).toEqual({
      before: "dominik/store-write",
      after: "dominik/store-write",
      source: { before: "ref", after: "ref" },
    });
  });

  test("a base change right after a push applies to that push", () => {
    const push = head("p", "2026-11-24T14:20:12Z", "9f70", "ffad");
    const result = baseForPush(
      input({
        heads: [push],
        refChanges: [{ at: "2026-11-24T14:20:24Z", from: "dominik/context" }],
        push,
        baseRef: "dominik/cell-lookups",
      }),
    );
    expect(result.after).toBe("dominik/cell-lookups");
  });

  test("uses force-pushes recorded on the parent PR", () => {
    const prev = head("p1", "2026-11-24T14:00:00Z", "x", "cd03");
    const push = head("p2", "2026-11-24T14:38:05Z", "cd03", "cfbb");
    const branchPushes = new Map([
      [
        "dominik/store-write",
        [
          { at: "2026-11-24T13:11:18Z", before: "4ea5", after: "bd71" },
          { at: "2026-11-24T14:21:55Z", before: "2348", after: "a7a0" },
          { at: "2026-11-24T14:38:00Z", before: "a7a0", after: "3a3c" },
        ],
      ],
    ]);
    const result = baseForPush(input({ heads: [prev, push], push, baseRef: "dominik/store-write", branchPushes }));
    expect(result).toEqual({ before: "2348", after: "3a3c", source: { before: "nextBasePush", after: "basePush" } });
  });

  test("without a previous head push, parent pushes long before the push are not used", () => {
    const push = head("p", "2026-11-24T14:38:05Z", "cd03", "cfbb");
    const branchPushes = new Map([["dominik/parent", [{ at: "2026-11-24T13:00:00Z", before: "1111", after: "2222" }]]]);
    const result = baseForPush(input({ heads: [push], push, baseRef: "dominik/parent", branchPushes }));
    expect(result.before).toBe("dominik/parent");
  });

  test("without a previous head push, a base change just before the push puts the old head on the earlier base", () => {
    const push = head("p", "2026-11-24T14:38:05Z", "cd03", "cfbb");
    const result = baseForPush(
      input({
        heads: [push],
        refChanges: [{ at: "2026-11-24T14:38:03Z", from: "dominik/cell-lookups" }],
        push,
        baseRef: "dominik/store-write",
      }),
    );
    expect(result).toEqual({
      before: "dominik/cell-lookups",
      after: "dominik/store-write",
      source: { before: "ref", after: "ref" },
    });
  });

  test("without a previous head push, a parent push seconds before the push gives the before side", () => {
    const push = head("p", "2026-11-24T14:38:05Z", "cd03", "cfbb");
    const branchPushes = new Map([["dominik/parent", [{ at: "2026-11-24T14:38:00Z", before: "1111", after: "2222" }]]]);
    const result = baseForPush(input({ heads: [push], push, baseRef: "dominik/parent", branchPushes }));
    expect(result).toEqual({ before: "1111", after: "2222", source: { before: "nextBasePush", after: "basePush" } });
  });
});

describe("pushHistory", () => {
  function item(typename: string, createdAt: string, raw: unknown, nodeId = typename): TimelineItemRecord {
    return { nodeId, subjectKey: "o/r#1", typename, createdAt, raw, fetchedAt: createdAt };
  }

  test("extracts pushes and ref changes in time order", () => {
    const history = pushHistory([
      item("AutomaticBaseChangeSucceededEvent", "2026-01-01T00:00:04Z", { oldBase: "parent", newBase: "master" }),
      item("HeadRefForcePushedEvent", "2026-01-01T00:00:02Z", { beforeCommit: { oid: "a" }, afterCommit: { oid: "b" } }, "H1"),
      item("BaseRefForcePushedEvent", "2026-01-01T00:00:01Z", { beforeCommit: { oid: "c" }, afterCommit: { oid: "d" } }),
      item("BaseRefChangedEvent", "2026-01-01T00:00:03Z", { previousRefName: "main", currentRefName: "parent" }),
      item("HeadRefForcePushedEvent", "2026-01-01T00:00:05Z", { beforeCommit: null, afterCommit: { oid: "e" } }),
      item("IssueComment", "2026-01-01T00:00:06Z", {}),
    ]);
    expect(history).toEqual({
      heads: [{ id: "H1", at: "2026-01-01T00:00:02Z", before: "a", after: "b" }],
      baseForces: [{ at: "2026-01-01T00:00:01Z", before: "c", after: "d" }],
      refChanges: [
        { at: "2026-01-01T00:00:03Z", from: "main" },
        { at: "2026-01-01T00:00:04Z", from: "parent" },
      ],
    });
  });
});

describe("needsVerdict", () => {
  const config = resolveConfig({ repos: { "o/over": { view: "overview" }, "o/tri": { view: "triage" } } });
  const pr = { kind: "pr" as const, state: "OPEN" as const, repo: "o/over" };

  test("open PRs in overview repos", () => {
    expect(needsVerdict(pr, config)).toBe(true);
    expect(needsVerdict({ ...pr, repo: "o/tri" }, config)).toBe(false);
    expect(needsVerdict({ ...pr, state: "MERGED" }, config)).toBe(false);
    expect(needsVerdict({ ...pr, kind: "issue" }, config)).toBe(false);
  });

  test("off when rebase detection is disabled", () => {
    const off = resolveConfig({ repos: { "o/over": { view: "overview" } }, rebase: { enabled: false } });
    expect(needsVerdict(pr, off)).toBe(false);
  });
});
