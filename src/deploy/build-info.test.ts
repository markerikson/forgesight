import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthHandler } from "../server/handlers/health.ts";
import { buildInfo, writeBuildInfo } from "./build-info.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forgesight-build-info-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const now = new Date("2026-11-26T12:00:00Z");
const sha = "fb1ea97396c0ffee00000000000000000000abcd";

describe("buildInfo", () => {
  test("accepts full, short and dirty shas", () => {
    expect(buildInfo(sha, now)).toEqual({ sha, time: "2026-11-26T12:00:00.000Z" });
    expect(buildInfo("fb1ea97", now).sha).toBe("fb1ea97");
    expect(buildInfo(`${sha}-dirty`, now).sha).toBe(`${sha}-dirty`);
  });

  test("rejects anything else", () => {
    expect(() => buildInfo("", now)).toThrow();
    expect(() => buildInfo("main", now)).toThrow();
  });

  test("health reports what the deploy wrote", async () => {
    await writeBuildInfo(root, sha, now);
    const res = await healthHandler(new Request("http://127.0.0.1:4630/api/health"), { root });
    expect(await res.json()).toEqual({
      ok: true,
      version: sha,
      buildInfo: { sha, time: "2026-11-26T12:00:00.000Z" },
    });
  });
});
