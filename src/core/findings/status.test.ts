import { describe, expect, test } from "bun:test";
import type { ReviewThreadRecord, StickyCommentVersion } from "../types.ts";
import { buildCopyMarkdown } from "./copy.ts";
import { type DeriveFindingsInput, deriveFindings, findingIcons, sameChanges } from "./status.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function item(fp: string, sev: string, title = `Finding ${fp}`): string {
  return `  - 🟠 **${sev}** ${title} — [L1](https://example.test/f#L1) · _[1]_ <!-- ai-review kind=summary-item file=src/x.ts line=1 fp=${fp} sev=${sev} -->`;
}

function sticky(at: string, head: string, items: string[], stoppedAt?: string): StickyCommentVersion {
  const body = [
    stoppedAt ? `> ⏸️ **Reviews stopped.** <!-- ai-review kind=stopped round=4 max=3 head=${stoppedAt} -->` : "",
    ...items,
    `<!-- ai-review kind=summary pr=1 runs=1 head=${head} -->`,
  ].join("\n");
  return {
    commentNodeId: "IC_1",
    bodyHash: `${at}-${head}`,
    subjectKey: "o/r#1",
    author: "github-actions",
    lastEditedAt: at,
    seenAt: at,
    lastSeenAt: at,
    body,
  };
}

function crThread(id: string, opts: { resolved?: boolean; outdated?: boolean; addressed?: boolean; sev?: string; at?: string }): ReviewThreadRecord {
  const body = [
    "<!-- coderabbit-ai-generated:v1 -->",
    "",
    `**<picture><img src="x" alt=""></picture> ${opts.sev ?? "Major"}** · **Functional Correctness** · **Quick win**`,
    "",
    `**Fix thread ${id}.**`,
    opts.addressed ? "\n✅ Addressed in commit 1234567" : "",
  ].join("\n");
  return {
    nodeId: id,
    subjectKey: "o/r#1",
    isResolved: opts.resolved ?? false,
    isOutdated: opts.outdated ?? false,
    path: "src/y.ts",
    line: 7,
    raw: { comments: { nodes: [{ id: `c-${id}`, author: { login: "coderabbitai" }, body, createdAt: opts.at ?? "2026-11-20T00:00:00Z", url: `https://example.test/${id}` }] } },
    fetchedAt: "2026-11-25T00:00:00Z",
  };
}

function input(over: Partial<DeriveFindingsInput>): DeriveFindingsInput {
  return { headSha: A, stickies: [], reviewThreads: [], pushes: [], since: null, ...over };
}

describe("sameChanges", () => {
  test("follows rebase pushes only", () => {
    expect(sameChanges(A, A, [])).toBe(true);
    expect(sameChanges(A, C, [{ before: A, after: B, restack: true }, { before: B, after: C, restack: true }])).toBe(true);
    expect(sameChanges(A, C, [{ before: A, after: B, restack: true }, { before: B, after: C, restack: false }])).toBe(false);
    expect(sameChanges(A, B, [])).toBe(false);
    expect(sameChanges(null, A, [])).toBe(false);
  });
});

describe("deriveFindings: DiffLoupe", () => {
  test("latest run on the current head is outstanding; dropped findings are fixed", () => {
    const out = deriveFindings(
      input({
        stickies: [
          sticky("2026-11-20T00:00:00Z", B, [item("f1", "should-fix"), item("f2", "question")]),
          sticky("2026-11-21T00:00:00Z", A, [item("f1", "should-fix")]),
        ],
        since: "2026-11-20T12:00:00Z",
      }),
    );
    expect(out.map((f) => [f.id, f.status, f.isNew, f.firstSeenAt])).toEqual([
      ["f1", "outstanding", false, "2026-11-20T00:00:00Z"],
      ["f2", "fixed", false, "2026-11-20T00:00:00Z"],
    ]);
    expect(out[0]?.serious).toBe(true);
  });

  test("a real push after the review makes findings stale", () => {
    const out = deriveFindings(input({ headSha: C, stickies: [sticky("2026-11-20T00:00:00Z", A, [item("f1", "blocker")])] }));
    expect(out[0]).toMatchObject({ status: "stale", note: null, isNew: true });
  });

  test("a rebase after the review keeps findings outstanding", () => {
    const out = deriveFindings(
      input({ headSha: B, stickies: [sticky("2026-11-20T00:00:00Z", A, [item("f1", "blocker")])], pushes: [{ before: A, after: B, restack: true }] }),
    );
    expect(out[0]?.status).toBe("outstanding");
  });

  test("stopped reviews leave findings stale with a note", () => {
    const out = deriveFindings(input({ headSha: C, stickies: [sticky("2026-11-20T00:00:00Z", A, [item("f1", "should-fix")], C)] }));
    expect(out[0]).toMatchObject({ status: "stale", note: "reviews stopped at cccccccccc" });
  });

  test("sticky version order does not matter", () => {
    const v1 = sticky("2026-11-20T00:00:00Z", B, [item("f1", "should-fix"), item("f2", "question")]);
    const v2 = sticky("2026-11-21T00:00:00Z", A, [item("f1", "should-fix")]);
    expect(deriveFindings(input({ stickies: [v2, v1] }))).toEqual(deriveFindings(input({ stickies: [v1, v2] })));
  });
});

describe("deriveFindings: CodeRabbit", () => {
  test("thread states", () => {
    const out = deriveFindings(
      input({
        reviewThreads: [
          crThread("t1", {}),
          crThread("t2", { outdated: true }),
          crThread("t3", { resolved: true }),
          crThread("t4", { resolved: true, outdated: true, addressed: true, sev: "Minor" }),
        ],
      }),
    );
    expect(out.map((f) => [f.id, f.status, f.severity])).toEqual([
      ["t1", "outstanding", "major"],
      ["t2", "stale", "major"],
      ["t4", "fixed", "minor"],
      ["t3", "resolved", "major"],
    ]);
    expect(out[0]).toMatchObject({ file: "src/y.ts", line: 7, url: "https://example.test/t1", title: "Fix thread t1" });
  });

  test("ignores threads from other authors", () => {
    const human: ReviewThreadRecord = { ...crThread("t9", {}), raw: { comments: { nodes: [{ body: "**Major** nit", createdAt: "2026-11-20T00:00:00Z" }] } } };
    expect(deriveFindings(input({ reviewThreads: [human] }))).toEqual([]);
  });
});

describe("findingIcons and copy", () => {
  const findings = deriveFindings(
    input({
      headSha: C,
      stickies: [sticky("2026-11-20T00:00:00Z", A, [item("f1", "nice-to-have")])],
      reviewThreads: [crThread("t1", {}), crThread("t2", { sev: "Minor" }), crThread("t3", { resolved: true })],
    }),
  );

  test("one icon per tool with counts and worst severity", () => {
    expect(findingIcons(findings)).toEqual([
      { tool: "diffloupe", outstanding: 0, stale: 1, worst: "nice-to-have" },
      { tool: "coderabbit", outstanding: 2, stale: 0, worst: "major" },
    ]);
  });

  test("copies outstanding findings, stale ones on request", () => {
    const base = { repo: "o/r", number: 1, title: "Add thing", findings };
    const plain = buildCopyMarkdown({ ...base, includeStale: false });
    expect(plain.startsWith("# Findings: o/r#1 Add thing\n\n## CodeRabbit\n\n### [major] Fix thread t1")).toBe(true);
    expect(plain).not.toContain("Stale");
    expect(plain).not.toContain("t3");
    const withStale = buildCopyMarkdown({ ...base, includeStale: true });
    expect(withStale).toContain("## Stale (may already be fixed)");
    expect(withStale).toContain("Finding f1");
    expect(buildCopyMarkdown({ ...base, findings: [], includeStale: true })).toBe("");
  });
});
