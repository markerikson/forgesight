import { describe, expect, test } from "bun:test";
import { type CompareFile, type CompareSide, compareSides, fileSigs, normalizePatch } from "./patch.ts";

function file(overrides: Partial<CompareFile> & { filename: string }): CompareFile {
  return { sha: "blob", status: "modified", patch: "@@ -1,2 +1,2 @@\n ctx\n-old\n+new", previousFilename: null, ...overrides };
}

function side(files: CompareFile[], overrides: Partial<CompareSide> = {}): CompareSide {
  return { mergeBaseSha: "base1", totalCommits: 3, files, ...overrides };
}

describe("normalizePatch", () => {
  test("keeps only added and removed lines", () => {
    expect(normalizePatch("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n more")).toBe("-old\n+new");
  });

  test("keeps changed lines that start with -- or ++", () => {
    expect(normalizePatch("@@ -1,3 +1,3 @@\n--- note\n----\n+++x\n ctx")).toBe("--- note\n----\n+++x");
    const before = side([file({ filename: "m.sql", patch: "@@ -1 +1 @@\n--- old note" })]);
    const after = side([file({ filename: "m.sql", patch: "@@ -1 +1 @@\n--- new note" })], { mergeBaseSha: "base2" });
    expect(compareSides(before, after).verdict).toBe("changed");
  });

  test("ignores hunk offsets and context", () => {
    expect(normalizePatch("@@ -1,2 +1,2 @@\n a\n-x\n+y")).toBe(normalizePatch("@@ -40,2 +44,2 @@\n b\n-x\n+y"));
  });
});

describe("fileSigs", () => {
  test("uses the blob SHA when the patch is missing", () => {
    expect(fileSigs([file({ filename: "a.bin", patch: null, sha: "abc" })]).get("a.bin")).toBe("modified:\nblob:abc");
  });

  test("includes status and rename source", () => {
    const sig = fileSigs([file({ filename: "b.ts", status: "renamed", previousFilename: "a.ts", patch: "" })]).get("b.ts");
    expect(sig).toBe("renamed:a.ts\n");
  });
});

describe("compareSides", () => {
  test("equal patches on a new base are rebase_only", () => {
    const before = side([file({ filename: "a.ts" })]);
    const after = side([file({ filename: "a.ts", patch: "@@ -9,2 +9,2 @@\n other\n-old\n+new" })], { mergeBaseSha: "base2" });
    expect(compareSides(before, after)).toEqual({ verdict: "rebase_only", reason: "patches equal" });
  });

  test("equal patches on the same base are noop", () => {
    const files = [file({ filename: "a.ts" })];
    expect(compareSides(side(files), side(files))).toEqual({ verdict: "noop", reason: "patches equal, same base" });
  });

  test("counts files that differ or appear on one side", () => {
    const before = side([file({ filename: "a.ts" }), file({ filename: "b.ts" })]);
    const after = side([file({ filename: "a.ts", patch: "+other" }), file({ filename: "c.ts" })]);
    expect(compareSides(before, after)).toEqual({ verdict: "changed", reason: "3 files differ" });
  });

  test("one differing file", () => {
    expect(compareSides(side([file({ filename: "a.ts" })]), side([file({ filename: "a.ts", patch: "+x" })]))).toEqual({
      verdict: "changed",
      reason: "1 file differs",
    });
  });

  test("a truncated side counts as changed", () => {
    const files = [file({ filename: "a.ts" })];
    expect(compareSides(side(files), side(files, { totalCommits: 251 }))).toEqual({ verdict: "changed", reason: "truncated" });
    const many = Array.from({ length: 300 }, (_, i) => file({ filename: `f${i}.ts` }));
    expect(compareSides(side(many), side(many)).verdict).toBe("changed");
  });

  test("ignored files may differ without counting", () => {
    const ignore = [/^gen\/fingerprints\.json$/];
    const before = side([file({ filename: "a.ts" }), file({ filename: "gen/fingerprints.json", patch: "-v1\n+v2" })]);
    const after = side([file({ filename: "a.ts" }), file({ filename: "gen/fingerprints.json", patch: "-v3\n+v4" })], {
      mergeBaseSha: "base2",
    });
    expect(compareSides(before, after, ignore)).toEqual({
      verdict: "rebase_only",
      reason: "patches equal (1 ignored file differs)",
    });
    expect(compareSides(before, after).verdict).toBe("changed");
  });

  test("other differing files still count when ignored ones differ too", () => {
    const ignore = [/fingerprints\.json$/];
    const before = side([file({ filename: "a.ts" }), file({ filename: "fingerprints.json", patch: "+1" })]);
    const after = side([file({ filename: "a.ts", patch: "+x" }), file({ filename: "fingerprints.json", patch: "+2" })]);
    expect(compareSides(before, after, ignore)).toEqual({ verdict: "changed", reason: "1 file differs" });
  });
});
