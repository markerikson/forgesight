import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthHandler } from "./health.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forgesight-health-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const req = new Request("http://127.0.0.1:4630/api/health");

describe("healthHandler", () => {
  test("answers without build info", async () => {
    const res = await healthHandler(req, { root });
    expect(await res.json()).toEqual({ ok: true, version: "dev", buildInfo: null });
  });

  test("reports build-info.json", async () => {
    writeFileSync(join(root, "build-info.json"), JSON.stringify({ sha: "abc123", time: "2026-11-23T00:00:00Z" }));
    const res = await healthHandler(req, { root });
    expect(await res.json()).toEqual({
      ok: true,
      version: "abc123",
      buildInfo: { sha: "abc123", time: "2026-11-23T00:00:00Z" },
    });
  });

  test("ignores an unreadable build-info.json", async () => {
    writeFileSync(join(root, "build-info.json"), "{not json");
    const res = await healthHandler(req, { root });
    expect(await res.json()).toEqual({ ok: true, version: "dev", buildInfo: null });
  });
});
