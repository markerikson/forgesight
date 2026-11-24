import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { getMeta, setMeta } from "./meta.ts";
import { latest, migrations, runMigrations } from "./migrate.ts";
import { assertCurrent, SCHEMA_VERSION } from "./schema-version.ts";

function tableNames(db: ReturnType<typeof openDb>): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

describe("migrations", () => {
  test("apply from version 0", () => {
    const db = openDb(":memory:");
    expect(runMigrations(db)).toEqual({ from: 0, to: 1 });
    expect(tableNames(db)).toEqual([
      "api_calls",
      "changes",
      "item_state",
      "meta",
      "review_threads",
      "sticky_versions",
      "subject_views",
      "subjects",
      "threads",
      "timeline_items",
    ]);
    assertCurrent(db);
  });

  test("rerun is a no-op", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    setMeta(db, "k", "v", "2026-01-01T00:00:00Z");
    expect(runMigrations(db)).toEqual({ from: 1, to: 1 });
    expect(getMeta(db, "k")).toBe("v");
  });

  test("assertCurrent throws when the database is behind", () => {
    const db = openDb(":memory:");
    expect(() => assertCurrent(db)).toThrow(/version 0/);
    runMigrations(db);
    expect(() => assertCurrent(db, SCHEMA_VERSION + 1)).toThrow(/expects 2/);
  });

  test("SCHEMA_VERSION matches the newest migration", () => {
    expect(latest(migrations)).toBe(SCHEMA_VERSION);
  });

  test("refuses to run against a newer database", () => {
    const db = openDb(":memory:");
    db.run("PRAGMA user_version = 5");
    expect(() => runMigrations(db)).toThrow(/newer/);
    expect(() => assertCurrent(db)).toThrow(/newer/);
  });
});

describe("two connections on one file", () => {
  const dir = mkdtempSync(join(tmpdir(), "forgesight-store-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a reader sees committed writes in WAL mode", () => {
    const path = join(dir, "inbox.db");
    const writer = openDb(path);
    runMigrations(writer);
    const reader = openDb(path, { readonly: true });
    assertCurrent(reader);

    expect(
      writer.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
    ).toBe("wal");

    expect(getMeta(reader, "cursor")).toBeUndefined();
    setMeta(writer, "cursor", "42", "2026-01-01T00:00:00Z");
    expect(getMeta(reader, "cursor")).toBe("42");

    reader.close();
    writer.close();
  });
});
