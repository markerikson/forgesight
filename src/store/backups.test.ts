import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDb, backupFileName, backupsToDelete, dateTag, preDeployTag } from "./backups.ts";

function days(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `inbox-2026-11-${String(i + 1).padStart(2, "0")}.db`);
}

describe("backupsToDelete", () => {
  test("keeps the newest 14 dated backups", () => {
    const files = days(16).map((name) => ({ name, mtimeMs: 0 }));
    expect(backupsToDelete(files)).toEqual(["inbox-2026-11-02.db", "inbox-2026-11-01.db"]);
  });

  test("keeps the newest 5 pre-deploy backups by mtime", () => {
    const files = ["f", "a", "c", "e", "b", "d", "g"].map((sha, i) => ({
      name: `inbox-pre-deploy-${sha}.db`,
      mtimeMs: i,
    }));
    expect(backupsToDelete(files)).toEqual(["inbox-pre-deploy-a.db", "inbox-pre-deploy-f.db"]);
  });

  test("counts dated and pre-deploy backups separately and leaves other tags alone", () => {
    const files = [
      ...days(14).map((name) => ({ name, mtimeMs: 0 })),
      ...["a", "b", "c", "d", "e"].map((sha, i) => ({ name: `inbox-pre-deploy-${sha}.db`, mtimeMs: i })),
      { name: "inbox-manual.db", mtimeMs: 0 },
      { name: "inbox-2026-1-1.db", mtimeMs: 0 },
    ];
    expect(backupsToDelete(files)).toEqual([]);
    expect(backupsToDelete(files, { dated: 13, preDeploy: 4 })).toEqual([
      "inbox-2026-11-01.db",
      "inbox-pre-deploy-a.db",
    ]);
  });
});

describe("backup names", () => {
  test("dateTag is the UTC date", () => {
    expect(dateTag(new Date("2026-11-26T23:30:00-05:00"))).toBe("2026-11-27");
  });

  test("preDeployTag adds the UTC time so repeated deploys of a commit get separate backups", () => {
    const tag = preDeployTag("abc1234-dirty", new Date("2026-11-26T20:30:05.123-05:00"));
    expect(tag).toBe("pre-deploy-abc1234-dirty-20261127T013005Z");
    expect(backupFileName(tag)).toBe("inbox-pre-deploy-abc1234-dirty-20261127T013005Z.db");
  });

  test("rejects tags that are not plain file name parts", () => {
    expect(backupFileName("pre-deploy-abc123")).toBe("inbox-pre-deploy-abc123.db");
    expect(() => backupFileName("../x")).toThrow();
    expect(() => backupFileName("a'b")).toThrow();
  });
});

describe("backupDb", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forgesight-backup-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("copies a live WAL database and replaces an existing backup", () => {
    const dbPath = join(dir, "inbox.db");
    const db = new Database(dbPath, { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE t (v TEXT)");
    db.run("INSERT INTO t VALUES ('kept')");

    const out = join(dir, "inbox-x.db");
    writeFileSync(out, "old");
    backupDb(dbPath, out);
    db.close();

    const copy = new Database(out, { readonly: true });
    expect(copy.query("SELECT v FROM t").all()).toEqual([{ v: "kept" }]);
    copy.close();
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });
});
