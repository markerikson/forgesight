import { describe, expect, test } from "bun:test";
import { pm2AppState, readiness } from "./pm2.ts";

const now = 1_000_000;
const jlist = JSON.stringify([
  { name: "tradewars", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0 } },
  { name: "forgesight-worker", pm2_env: { status: "online", pm_uptime: now - 12_000, restart_time: 2 } },
]);

describe("pm2AppState", () => {
  test("finds the app by name", () => {
    expect(pm2AppState(jlist, "forgesight-worker", now)).toEqual({ status: "online", uptimeMs: 12_000, restarts: 2 });
  });

  test("returns null for a missing app or odd output", () => {
    expect(pm2AppState(jlist, "forgesight-web", now)).toBeNull();
    expect(pm2AppState("{}", "forgesight-web", now)).toBeNull();
  });
});

describe("readiness", () => {
  test("waits for the minimum uptime", () => {
    expect(readiness({ status: "online", uptimeMs: 9_000, restarts: 0 }, 10_000)).toBe("waiting");
    expect(readiness({ status: "online", uptimeMs: 10_000, restarts: 0 }, 10_000)).toBe("ready");
  });

  test("treats a launching or missing app as waiting and errored as failed", () => {
    expect(readiness({ status: "launching", uptimeMs: 60_000, restarts: 3 }, 10_000)).toBe("waiting");
    expect(readiness(null, 10_000)).toBe("waiting");
    expect(readiness({ status: "errored", uptimeMs: 0, restarts: 10 }, 10_000)).toBe("failed");
  });
});
