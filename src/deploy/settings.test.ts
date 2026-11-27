import { describe, expect, test } from "bun:test";
import { expandHome, parseEnvFile, remoteCommand, resolveSettings, rsyncPlatformFlags, shellQuote } from "./settings.ts";

describe("parseEnvFile", () => {
  test("reads KEY=value lines, skipping blanks and comments", () => {
    const text = "# deploy settings\n\nDEPLOY_SERVER=myvm\r\nexport DEPLOY_DIR = /srv/app\n";
    expect(parseEnvFile(text)).toEqual({ DEPLOY_SERVER: "myvm", DEPLOY_DIR: "/srv/app" });
  });

  test("strips matching quotes and trailing comments on unquoted values", () => {
    const text = `A="with spaces # kept"\nB='single'\nC=plain # note\nD=`;
    expect(parseEnvFile(text)).toEqual({ A: "with spaces # kept", B: "single", C: "plain", D: "" });
  });

  test("does not expand variables", () => {
    expect(parseEnvFile("A=$HOME/x")).toEqual({ A: "$HOME/x" });
  });

  test("rejects lines that are not assignments", () => {
    expect(() => parseEnvFile("not an assignment")).toThrow("can't parse line");
  });
});

describe("expandHome", () => {
  test("expands a leading ~ only", () => {
    expect(expandHome("~/x/y", "/home/me")).toBe("/home/me/x/y");
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("/a/~/b", "/home/me")).toBe("/a/~/b");
    expect(expandHome("~other/x", "/home/me")).toBe("~other/x");
  });
});

describe("resolveSettings", () => {
  test("applies defaults and expands ~ in paths", () => {
    expect(resolveSettings({ DEPLOY_SERVER: "vm", DEPLOY_CONFIG_FILE: "~/c.jsonc" }, {}, "/home/me")).toEqual({
      server: "vm",
      dir: "/opt/forgesight",
      envFile: ".env.production",
      configFile: "/home/me/c.jsonc",
    });
  });

  test("lets environment variables override the file", () => {
    const settings = resolveSettings({ DEPLOY_SERVER: "vm", DEPLOY_DIR: "/a" }, { DEPLOY_SERVER: "other" }, "/h");
    expect(settings.server).toBe("other");
    expect(settings.dir).toBe("/a");
  });

  test("requires DEPLOY_SERVER", () => {
    expect(() => resolveSettings({}, { DEPLOY_SERVER: "" }, "/h")).toThrow("DEPLOY_SERVER is not set");
  });

  test("rejects a DEPLOY_DIR that is not absolute instead of expanding ~ locally", () => {
    for (const dir of ["~/forgesight", "forgesight"]) {
      expect(() => resolveSettings({ DEPLOY_SERVER: "vm", DEPLOY_DIR: dir }, {}, "/h")).toThrow(
        "DEPLOY_DIR must be an absolute path",
      );
    }
  });
});

describe("remote commands", () => {
  test("shellQuote survives embedded single quotes", async () => {
    const value = `it's "quoted" $HOME`;
    const out = await Bun.$`bash -c ${`printf %s ${shellQuote(value)}`}`.text();
    expect(out).toBe(value);
  });

  test("remoteCommand runs in the app dir through a login shell", async () => {
    const cmd = remoteCommand("/tmp", "pwd && printf %s 'a b'");
    expect(cmd.startsWith("bash -lc ")).toBe(true);
    // ssh hands the string to the remote user's shell, which is what this simulates.
    const out = await Bun.$`sh -c ${cmd}`.text();
    expect(out).toBe("/tmp\na b");
  });

  test("rsync gets an older protocol only on Windows", () => {
    expect(rsyncPlatformFlags("win32")).toEqual(["--protocol=32"]);
    expect(rsyncPlatformFlags("linux")).toEqual([]);
  });
});
