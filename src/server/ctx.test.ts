import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../store/db.ts";
import { runMigrations } from "../store/migrate.ts";
import { NotReadyError, openServerDb } from "./ctx.ts";

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
