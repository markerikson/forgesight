import { describe, expect, test } from "bun:test";
import { hostGuard, originGuard } from "./guards.ts";

function req(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(url, init);
}

describe("hostGuard", () => {
  test("allows loopback hosts with or without a port", () => {
    expect(hostGuard(req("http://127.0.0.1:4630/api/status"), [])).toBeNull();
    expect(hostGuard(req("http://localhost:4630/"), [])).toBeNull();
    expect(hostGuard(req("http://[::1]:4630/"), [])).toBeNull();
  });

  test("allows configured hosts case-insensitively", () => {
    const r = req("http://127.0.0.1:4630/", { headers: { host: "Inbox.Tailnet.ts.net" } });
    expect(hostGuard(r, ["inbox.tailnet.ts.net"])).toBeNull();
  });

  test("rejects other hosts with 403", async () => {
    const r = req("http://127.0.0.1:4630/", { headers: { host: "evil.example:4630" } });
    const res = hostGuard(r, ["inbox.tailnet.ts.net"]);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "host evil.example is not allowed" });
  });
});

describe("originGuard", () => {
  test("ignores safe methods", () => {
    const r = req("http://127.0.0.1:4630/api/status", { headers: { origin: "http://evil.example" } });
    expect(originGuard(r)).toBeNull();
  });

  test("allows same-origin writes", () => {
    const r = req("http://127.0.0.1:4630/api/x", {
      method: "POST",
      headers: { host: "127.0.0.1:4630", origin: "http://127.0.0.1:4630" },
    });
    expect(originGuard(r)).toBeNull();
  });

  test("rejects cross-origin writes", () => {
    const r = req("http://127.0.0.1:4630/api/x", {
      method: "POST",
      headers: { host: "127.0.0.1:4630", origin: "http://evil.example" },
    });
    expect(originGuard(r)?.status).toBe(403);
  });

  test("without Origin, rejects only what the browser marks cross-site", () => {
    const plain = req("http://127.0.0.1:4630/api/x", { method: "POST" });
    expect(originGuard(plain)).toBeNull();
    const crossSite = req("http://127.0.0.1:4630/api/x", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(originGuard(crossSite)?.status).toBe(403);
  });
});
