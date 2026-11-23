import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, dataDir } from "./paths.ts";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forgesight-paths-"));
  home = join(root, "home");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("dataDir", () => {
  test("FORGESIGHT_DATA_DIR wins and is resolved to an absolute path", () => {
    const dir = join(root, "custom");
    expect(
      dataDir({ FORGESIGHT_DATA_DIR: dir, XDG_DATA_HOME: join(root, "xdg") }, home),
    ).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });

  test("falls back to XDG_DATA_HOME/forgesight", () => {
    const xdg = join(root, "xdg");
    expect(dataDir({ XDG_DATA_HOME: xdg }, home)).toBe(join(xdg, "forgesight"));
    expect(existsSync(join(xdg, "forgesight"))).toBe(true);
  });

  test("falls back to ~/.local/share/forgesight, treating empty vars as unset", () => {
    const expected = join(home, ".local", "share", "forgesight");
    expect(dataDir({ FORGESIGHT_DATA_DIR: "", XDG_DATA_HOME: "" }, home)).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });
});

describe("configPath", () => {
  test("FORGESIGHT_CONFIG wins", () => {
    const file = join(root, "elsewhere", "my.jsonc");
    expect(configPath({ FORGESIGHT_CONFIG: file }, home)).toBe(file);
    expect(existsSync(join(root, "elsewhere"))).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("falls back to XDG_CONFIG_HOME/forgesight/config.jsonc", () => {
    const xdg = join(root, "xdgc");
    expect(configPath({ XDG_CONFIG_HOME: xdg }, home)).toBe(
      join(xdg, "forgesight", "config.jsonc"),
    );
  });

  test("falls back to ~/.config/forgesight/config.jsonc", () => {
    expect(configPath({}, home)).toBe(join(home, ".config", "forgesight", "config.jsonc"));
    expect(existsSync(join(home, ".config", "forgesight"))).toBe(true);
  });
});
