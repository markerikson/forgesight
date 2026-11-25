import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { getItemState } from "./item-state.ts";
import { getMeta, setMeta } from "./meta.ts";
import { latest, migrations, runMigrations } from "./migrate.ts";
import { assertCurrent, SCHEMA_VERSION } from "./schema-version.ts";
import { getSubject } from "./subjects.ts";

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
    expect(runMigrations(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(tableNames(db)).toEqual([
      "api_calls",
      "changes",
      "item_state",
      "llm_calls",
      "llm_jobs",
      "meta",
      "outbox",
      "pr_texts",
      "review_threads",
      "state_ops",
      "sticky_versions",
      "subject_views",
      "subjects",
      "summaries",
      "threads",
      "timeline_items",
      "workstream_members",
      "workstream_overrides",
      "workstream_state",
      "workstreams",
    ]);
    assertCurrent(db);
  });

  test("rerun is a no-op", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    setMeta(db, "k", "v", "2026-01-01T00:00:00Z");
    expect(runMigrations(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(getMeta(db, "k")).toBe("v");
  });

  test("003 upgrades a version 2 database and keeps subjects, views and state ops", () => {
    const db = openDb(":memory:");
    expect(runMigrations(db, migrations.slice(0, 2))).toEqual({ from: 0, to: 2 });
    db.run(
      `INSERT INTO subjects (subject_key, repo, number, kind, origin) VALUES ('acme/app#1', 'acme/app', 1, 'pr', 'thread')`,
    );
    db.run(
      `INSERT INTO state_ops (created_at, op_json, prev_json) VALUES ('2026-01-01T00:00:00Z', '{"kind":"done"}', '{}')`,
    );
    setMeta(db, "openPulls.acme/app", '{"pulls":[]}', "2026-01-01T00:00:00Z");

    expect(runMigrations(db)).toEqual({ from: 2, to: SCHEMA_VERSION });
    assertCurrent(db);
    expect(getSubject(db, "acme/app#1")?.origin).toBe("thread");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM state_ops").get()?.n).toBe(1);
    expect(getMeta(db, "openPulls.acme/app")).toBe('{"pulls":[]}');
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM workstreams").get()?.n).toBe(0);
    db.run(
      `INSERT INTO workstream_state (workstream_id, updated_at) VALUES ('acme/app:ws:1', '2026-01-02T00:00:00Z')`,
    );
    expect(
      db.query<{ priority: string }, []>("SELECT priority FROM workstream_state").get()?.priority,
    ).toBe("normal");
  });

  test("002 upgrades a version 1 database and keeps its item state", () => {
    const db = openDb(":memory:");
    expect(runMigrations(db, migrations.slice(0, 1))).toEqual({ from: 0, to: 1 });
    db.run(
      `INSERT INTO item_state (subject_key, dismissed_at, keep_unread, snooze_until, muted, updated_at)
       VALUES ('acme/app#1', '2026-01-01T00:00:00Z', 1, '2026-02-01T00:00:00Z', 1, '2026-01-01T00:00:00Z')`,
    );
    setMeta(db, "k", "v", "2026-01-01T00:00:00Z");

    expect(runMigrations(db, migrations.slice(0, 2))).toEqual({ from: 1, to: 2 });
    expect(getItemState(db, "acme/app#1")).toEqual({
      dismissedAt: "2026-01-01T00:00:00Z",
      doneAt: null,
      keepUnread: true,
      snoozeUntil: "2026-02-01T00:00:00Z",
      snoozeUntilHumanEvent: false,
      snoozeUntilReady: false,
      snoozedAt: null,
      muted: true,
    });
    expect(getMeta(db, "k")).toBe("v");
  });

  test("assertCurrent throws when the database is behind", () => {
    const db = openDb(":memory:");
    expect(() => assertCurrent(db)).toThrow(/version 0/);
    runMigrations(db);
    expect(() => assertCurrent(db, SCHEMA_VERSION + 1)).toThrow(new RegExp(`expects ${SCHEMA_VERSION + 1}`));
  });

  test("SCHEMA_VERSION matches the newest migration", () => {
    expect(latest(migrations)).toBe(SCHEMA_VERSION);
  });

  test("refuses to run against a newer database", () => {
    const db = openDb(":memory:");
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
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
