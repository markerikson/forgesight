import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../config/load.ts";
import { repoConfig } from "./config.ts";
import { linkName, linksFor } from "./links.ts";
import type { Event, EventData, EventKind, SubjectRef } from "./pipeline/types.ts";
import type { SubjectRecord } from "./types.ts";

const REPO = "reduxjs/redux-toolkit";

function subject(kind: SubjectRecord["kind"], raw: Record<string, unknown> = {}, headRef: string | null = null): SubjectRecord {
  return {
    subjectKey: `${REPO}#10`,
    repo: REPO,
    number: 10,
    kind,
    nodeId: "S1",
    origin: "thread",
    state: "OPEN",
    author: "bob",
    headRef,
    baseRef: null,
    headSha: null,
    baseSha: null,
    updatedAt: null,
    timelineSyncedUntil: null,
    dirtyAt: null,
    priority: 0,
    enrichError: null,
    enrichAttempts: 0,
    raw,
  };
}

let seq = 0;
function event(kind: EventKind, data: Partial<EventData>): Event {
  seq++;
  return { id: `E${seq}`, at: "2026-11-21T00:00:00Z", actor: null, kind, data: { typename: "X", ...data } };
}

const ref = (kind: "pr" | "issue", number: number, extra: Partial<SubjectRef> = {}): SubjectRef => ({
  kind,
  repo: REPO,
  number,
  ...extra,
});

const node = (number: number, state: string, repo = REPO) => ({
  number,
  title: `T${number}`,
  state,
  repository: { nameWithOwner: repo },
});

const config = (branchRules: { pattern: string; link: "issue" }[] = []) =>
  repoConfig(resolveConfig({ repos: { [REPO]: { branchRules } } }), REPO);

describe("linksFor", () => {
  test("a PR links the issues it closes and the issue its branch names", () => {
    const pr = subject("pr", { closingIssuesReferences: { nodes: [node(1, "OPEN")] } }, "fix/qa-issue-2");
    const links = linksFor({ subject: pr, events: [], config: config([{ pattern: "^fix/qa-issue-(\\d+)$", link: "issue" }]) });
    expect(links).toEqual([
      { kind: "issue", repo: REPO, number: 1, relation: "closes", title: "T1", state: "OPEN" },
      { kind: "issue", repo: REPO, number: 2, relation: "branchRule" },
    ]);
  });

  test("an issue links its closing PRs, keeping cross-repo ones", () => {
    const issue = subject("issue", {
      closedByPullRequestsReferences: { nodes: [node(5, "MERGED"), node(6, "OPEN", "reduxjs/react-redux")] },
    });
    const links = linksFor({ subject: issue, events: [], config: config() });
    expect(links.map((l) => [l.repo, l.number, l.relation, l.state])).toEqual([
      [REPO, 5, "closedBy", "MERGED"],
      ["reduxjs/react-redux", 6, "closedBy", "OPEN"],
    ]);
  });

  test("one entry per subject keeps the strongest relation and fills in details", () => {
    const issue = subject("issue");
    const events = [
      event("connected", { ref: ref("pr", 5), added: true }),
      event("crossReference", { ref: ref("pr", 5, { title: "Fix", state: "MERGED" }), willClose: true }),
      event("markedDuplicate", { ref: ref("issue", 3) }),
    ];
    expect(linksFor({ subject: issue, events, config: config() })).toEqual([
      { kind: "pr", repo: REPO, number: 5, relation: "closedBy", title: "Fix", state: "MERGED" },
      { kind: "issue", repo: REPO, number: 3, relation: "duplicate" },
    ]);
  });

  test("a disconnect removes a connection, and plain cross-references are not links", () => {
    const issue = subject("issue");
    const events = [
      event("connected", { ref: ref("pr", 5), added: true }),
      event("connected", { ref: ref("pr", 5), added: false }),
      event("connected", { ref: ref("pr", 7), added: true }),
      event("crossReference", { ref: ref("issue", 8), willClose: false }),
    ];
    expect(linksFor({ subject: issue, events, config: config() })).toEqual([
      { kind: "pr", repo: REPO, number: 7, relation: "connected" },
    ]);
  });

  test("a reference to the subject itself is skipped", () => {
    const pr = subject("pr", { closingIssuesReferences: { nodes: [node(10, "OPEN")] } });
    expect(linksFor({ subject: pr, events: [], config: config() })).toEqual([]);
  });
});

describe("linkName", () => {
  test("drops the repo for same-repo links", () => {
    expect(linkName({ repo: REPO, number: 5 }, REPO)).toBe("#5");
    expect(linkName({ repo: "reduxjs/reselect", number: 5 }, REPO)).toBe("reduxjs/reselect#5");
  });
});
