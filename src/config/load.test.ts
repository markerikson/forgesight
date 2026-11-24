import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoConfig } from "../core/config.ts";
import { defaultConfig } from "./defaults.ts";
import {
  ConfigError,
  canonicalJson,
  configHash,
  loadConfig,
  parseConfigText,
  resolveConfig,
} from "./load.ts";
import type { UserConfig } from "./schema.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forgesight-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const socket = {
  id: "socket",
  match: { author: "socket-security[bot]" },
  kind: "status",
  level: "hidden",
  override: [{ bodyRegex: "caution", level: "show" }],
} satisfies NonNullable<UserConfig["bots"]>[number];

describe("resolveConfig", () => {
  test("empty user config gives the defaults", () => {
    const config = resolveConfig({});
    expect(config.me).toBeNull();
    expect(config.repos).toEqual({ "*": { mode: "normal", batchSize: 10, branchRules: [] } });
    expect(config.server.port).toBe(4630);
    expect(config.polling.enrichIssues).toBe(true);
    expect(config.bots.map((b) => b.id)).toEqual((defaultConfig.bots ?? []).map((b) => b.id));
    expect(config.contentRules.map((r) => r.id)).toEqual((defaultConfig.contentRules ?? []).map((r) => r.id));
  });

  test("user values override defaults field by field", () => {
    const config = resolveConfig({
      me: "markerikson",
      polling: { backfillDays: 30 },
      server: { port: 5000 },
    });
    expect(config.me).toBe("markerikson");
    expect(config.polling).toEqual({
      backfillDays: 30,
      fullRefreshMinutes: 15,
      openPullsMinutes: 10,
      enrichIssues: true,
    });
    expect(config.server).toEqual({ port: 5000, allowedHosts: ["localhost", "127.0.0.1"] });
  });

  test("repo entries inherit missing fields from the resolved '*' entry", () => {
    const config = resolveConfig({
      repos: {
        "*": { batchSize: 5 },
        "replayio/backend": {
          mode: "full",
          branchRules: [{ pattern: "^fix/qa-issue-(\\d+)", link: "issue" }],
        },
        "chromium/chromium-v8": { mode: "simple", batchSize: 1 },
      },
    });
    expect(config.repos["*"]).toEqual({ mode: "normal", batchSize: 5, branchRules: [] });
    const backend = repoConfig(config, "replayio/backend");
    expect(backend.mode).toBe("full");
    expect(backend.batchSize).toBe(5);
    expect(backend.branchRules[0]?.pattern.test("fix/qa-issue-42")).toBe(true);
    expect(repoConfig(config, "chromium/chromium-v8")).toEqual({
      mode: "simple",
      batchSize: 1,
      branchRules: [],
    });
  });

  test("repoConfig uses the exact entry, then '*'", () => {
    const config = resolveConfig({ repos: { "a/b": { mode: "simple" } } });
    expect(repoConfig(config, "a/b").mode).toBe("simple");
    expect(repoConfig(config, "a/c").mode).toBe("normal");
  });

  test("rules with the same id replace defaults whole; new ids are appended", () => {
    const defaults: UserConfig = {
      ...defaultConfig,
      bots: [socket, { id: "netlify", match: { author: "netlify[bot]" }, level: "hidden" }],
    };
    const config = resolveConfig(
      {
        bots: [
          { id: "socket", match: { author: "socket-security[bot]" }, level: "collapsed" },
          { id: "mine", match: { htmlMarker: "<!-- mine -->" } },
        ],
      },
      defaults,
    );
    expect(config.bots.map((b) => b.id)).toEqual(["socket", "netlify", "mine"]);
    expect(config.bots[0]).toEqual({
      id: "socket",
      match: { author: "socket-security[bot]" },
      level: "collapsed",
      override: [],
      extract: {},
    });
    expect(config.bots[2]?.level).toBe("show");
  });

  test("rule regexes are compiled", () => {
    const config = resolveConfig({
      bots: [
        { ...socket, extract: { url: "https://\\S+\\.netlify\\.app" } },
      ],
      contentRules: [{ id: "lgtm", match: { bodyRegex: "^LGTM$" }, level: "collapsed" }],
    });
    const bot = config.bots.find((b) => b.id === socket.id);
    expect(bot?.override[0]?.bodyRegex).toBeInstanceOf(RegExp);
    expect(bot?.extract["url"]?.test("https://x.netlify.app")).toBe(true);
    expect(config.contentRules.find((r) => r.id === "lgtm")?.match.bodyRegex?.test("LGTM")).toBe(true);
  });

  test("an invalid regex throws ConfigError naming the field", () => {
    expect(() => resolveConfig({ contentRules: [{ id: "bad", match: { bodyRegex: "(" } }] }))
      .toThrow(ConfigError);
    expect(() =>
      resolveConfig({ repos: { "a/b": { branchRules: [{ pattern: "[", link: "issue" }] } } }),
    ).toThrow(/repos\["a\/b"\]\.branchRules\[0\]\.pattern/);
  });
});

describe("parseConfigText", () => {
  test("accepts JSONC comments and trailing commas", () => {
    const config = parseConfigText(`{
      // who I am
      "me": "markerikson", /* block */
      "server": { "port": 4700, },
    }`);
    expect(config.me).toBe("markerikson");
    expect(config.server.port).toBe(4700);
  });

  test("rejects unknown keys so typos are reported", () => {
    expect(() => parseConfigText(`{ "pollng": {} }`)).toThrow(/pollng/);
    expect(() => parseConfigText(`{ "polling": { "backfilDays": 3 } }`)).toThrow(/backfilDays/);
  });

  test("rejects wrong types and out-of-range values", () => {
    expect(() => parseConfigText(`{ "server": { "port": 0 } }`)).toThrow(ConfigError);
    expect(() => parseConfigText(`{ "repos": { "*": { "mode": "fast" } } }`)).toThrow(ConfigError);
    expect(() => parseConfigText(`{ "polling": { "enrichIssues": "yes" } }`)).toThrow(ConfigError);
  });

  test("rejects malformed JSONC", () => {
    expect(() => parseConfigText(`{ "me": `)).toThrow(/not valid JSONC/);
  });
});

describe("loadConfig", () => {
  test("missing file gives defaults and no error", async () => {
    const result = await loadConfig(join(dir, "nope.jsonc"));
    expect(result.error).toBeUndefined();
    expect(result.config).toEqual(resolveConfig({}));
    expect(result.hash).toBe(configHash(resolveConfig({})));
  });

  test("valid file is loaded", async () => {
    const path = join(dir, "config.jsonc");
    writeFileSync(path, `{ "me": "someone" } // trailing comment`);
    const result = await loadConfig(path);
    expect(result.error).toBeUndefined();
    expect(result.config.me).toBe("someone");
  });

  test("invalid file gives defaults plus an error", async () => {
    const path = join(dir, "config.jsonc");
    writeFileSync(path, `{ "server": { "port": "high" } }`);
    const result = await loadConfig(path);
    expect(result.error).toContain("Invalid config");
    expect(result.config).toEqual(resolveConfig({}));
  });
});

describe("configHash", () => {
  test("is stable across key order and changes with content", () => {
    const a = resolveConfig({ me: "x", server: { port: 1234, allowedHosts: ["a"] } });
    const b = resolveConfig({ server: { allowedHosts: ["a"], port: 1234 }, me: "x" });
    expect(configHash(a)).toBe(configHash(b));
    expect(configHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(configHash(resolveConfig({ me: "y" }))).not.toBe(configHash(a));
  });

  test("writes regexes as their source", () => {
    const config = resolveConfig({ contentRules: [{ id: "r", match: { bodyRegex: "^a+$" } }] });
    expect(canonicalJson(config)).toContain(`"bodyRegex":"^a+$"`);
  });
});
