import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCodeRabbitComment } from "./coderabbit.ts";
import { parseDiffLoupeInline, parseDiffLoupeSticky, parseMarkers } from "./diffloupe.ts";

const read = (name: string) => Bun.file(join(import.meta.dir, "__fixtures__", name)).text();

describe("parseMarkers", () => {
  test("reads kind and fields", () => {
    expect(parseMarkers("x <!-- ai-review kind=summary-item file=a/b.ts line=3 fp=abc sev=blocker --> y")).toEqual([
      { kind: "summary-item", fields: { kind: "summary-item", file: "a/b.ts", line: "3", fp: "abc", sev: "blocker" } },
    ]);
  });
});

describe("parseDiffLoupeSticky", () => {
  test("stopped review with one finding and its copy section", async () => {
    const run = parseDiffLoupeSticky(await read("diffloupe-stopped.md"));
    expect(run?.headSha).toBe("d9dd2bc3943ad7a841345ee6361e5a40d4727ac3");
    expect(run?.stoppedAt).toBe("cf8d176e57a9f67702b4e71f573d38c43f49d7a9");
    expect(run?.findings).toHaveLength(1);
    const f = run?.findings[0];
    expect(f).toMatchObject({
      tool: "diffloupe",
      id: "7251e4772f",
      severity: "should-fix",
      label: "Should fix",
      file: "packages/toolkit/src/query/core/buildSlice.ts",
      line: 407,
      title:
        "ignoreEarlierFetches does not discard an in-flight upsertQueryData when the entry already had a request",
      url: "https://github.com/reduxjs/redux-toolkit/blob/d9dd2bc3943ad7a841345ee6361e5a40d4727ac3/packages/toolkit/src/query/core/buildSlice.ts#L407",
    });
    expect(f?.copyText?.startsWith("### [should-fix] ignoreEarlierFetches")).toBe(true);
    expect(f?.copyText).toContain("id `7251e4772f`");
    expect(f?.copyText).toContain("**Suggestion:**");
    expect(f?.copyText).not.toContain("```");
  });

  test("review with no findings", async () => {
    const run = parseDiffLoupeSticky(await read("diffloupe-clean.md"));
    expect(run).toEqual({
      headSha: "7f63e915323e6446fc0442d0d469f9dafef711eb",
      stoppedAt: "82ea499dc231f95018163792bde7256b7007edb3",
      findings: [],
    });
  });

  test("carried items drop the Still open prefix", () => {
    const body = [
      "<details><summary>Still open from earlier reviews (1)</summary>",
      "",
      "- Still open: Cache key ignores the tenant <!-- ai-review kind=summary-item file=src/a.ts line=12 fp=8cc9020841 sev=question -->",
      "</details>",
      "<!-- ai-review kind=summary pr=1 runs=2 head=abc -->",
    ].join("\n");
    expect(parseDiffLoupeSticky(body)?.findings[0]).toMatchObject({
      id: "8cc9020841",
      title: "Cache key ignores the tenant",
      severity: "question",
      url: null,
      copyText: null,
    });
  });

  test("not a DiffLoupe summary", () => {
    expect(parseDiffLoupeSticky("Thanks!")).toBeNull();
    expect(parseDiffLoupeSticky("<!-- ai-review kind=reply -->")).toBeNull();
  });
});

describe("parseDiffLoupeInline", () => {
  test("title from the heading, location from the marker", () => {
    const body = [
      "#### Retry loop never backs off",
      "🟠 Should fix · Prod risk · `src/retry.ts:40`",
      "",
      "The delay is computed but not awaited.",
      "<!-- ai-review kind=inline file=src/retry.ts line=40 fp=0123456789 sev=should-fix -->",
    ].join("\n");
    expect(parseDiffLoupeInline(body, "https://example.test/c/1")).toMatchObject({
      tool: "diffloupe",
      id: "0123456789",
      severity: "should-fix",
      file: "src/retry.ts",
      line: 40,
      title: "Retry loop never backs off",
      url: "https://example.test/c/1",
    });
  });
});

describe("parseCodeRabbitComment", () => {
  test("major finding after a static analysis block", async () => {
    const c = parseCodeRabbitComment(await read("coderabbit-major.md"));
    expect(c?.addressedIn).toBeNull();
    expect(c?.report).toMatchObject({
      tool: "coderabbit",
      severity: "major",
      label: "Major",
      category: "Functional Correctness",
      title: "Guard the non-literal `addTagTypes` spread against `undefined`",
    });
    expect(c?.report.copyText?.startsWith("Review comment at @packages/rtk-codemods/transforms/enhanceEndpoint/index.ts")).toBe(true);
    expect(c?.report.copyText).not.toContain("untrusted review data");
    expect(c?.report.copyText).not.toContain("coderabbit review --agent");
  });

  test("addressed minor finding", async () => {
    const c = parseCodeRabbitComment(await read("coderabbit-addressed.md"));
    expect(c?.addressedIn).toBe("dc9ed10");
    expect(c?.report).toMatchObject({ severity: "minor", title: "Remove the unsupported default for `R`" });
  });

  test("not a CodeRabbit comment", () => {
    expect(parseCodeRabbitComment("**Major** looks wrong")).toBeNull();
  });
});
