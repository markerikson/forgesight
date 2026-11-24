import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../store/db.ts";
import { runMigrations } from "../store/migrate.ts";
import { SCHEMA_VERSION } from "../store/schema-version.ts";
import { NotReadyError, getCtx, openServerDb } from "./ctx.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forgesight-ctx-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openServerDb", () => {
  test("refuses a missing database", () => {
    expect(() => openServerDb(join(dir, "inbox.db"))).toThrow(NotReadyError);
  });

  test("refuses a database with pending migrations", () => {
    const path = join(dir, "inbox.db");
    openDb(path).close();
    expect(() => openServerDb(path)).toThrow(NotReadyError);
  });

  test("opens a migrated database read-only", () => {
    const path = join(dir, "inbox.db");
    const rw = openDb(path);
    runMigrations(rw);
    rw.close();
    const db = openServerDb(path);
    expect(() => db.run("CREATE TABLE x (a)")).toThrow();
    db.close();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("getCtx", () => {
  test("drops the cached connection when the schema changes under it", async () => {
    const saved = { data: process.env.FORGESIGHT_DATA_DIR, config: process.env.FORGESIGHT_CONFIG };
    process.env.FORGESIGHT_DATA_DIR = dir;
    process.env.FORGESIGHT_CONFIG = join(dir, "config.jsonc");
    try {
      const rw = openDb(join(dir, "inbox.db"));
      runMigrations(rw);
      const first = await getCtx();
      expect(await getCtx()).toBe(first);

      rw.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      await expect(getCtx()).rejects.toThrow(/newer than this code/);

      rw.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      const reopened = await getCtx();
      expect(reopened).not.toBe(first);
      reopened.db.close();
      rw.close();
    } finally {
      restoreEnv("FORGESIGHT_DATA_DIR", saved.data);
      restoreEnv("FORGESIGHT_CONFIG", saved.config);
    }
  });
});
