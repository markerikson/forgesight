import type { Database } from "bun:sqlite";
import type { ChangeKind, SubjectViewRecord } from "../core/types.ts";
import { type SubjectViewRow, toJson, viewFromRow } from "./rows.ts";

export interface ChangeRecord {
  seq: number;
  kind: ChangeKind;
  subjectKey: string | null;
}

/** Appends a change feed row and returns its sequence number. */
export function appendChange(
  db: Database,
  kind: ChangeKind,
  key: string | null,
  now: string,
): number {
  const row = db
    .query<{ seq: number }, [string, string, string | null]>(
      "INSERT INTO changes (at, kind, subject_key) VALUES (?, ?, ?) RETURNING seq",
    )
    .get(now, kind, key);
  if (!row) throw new Error("appendChange: insert returned no row");
  return row.seq;
}

export function changesAfter(db: Database, seq: number): ChangeRecord[] {
  return db
    .query<{ seq: number; kind: string; subject_key: string | null }, [number]>(
      "SELECT seq, kind, subject_key FROM changes WHERE seq > ? ORDER BY seq",
    )
    .all(seq)
    .map((r) => ({ seq: r.seq, kind: r.kind as ChangeKind, subjectKey: r.subject_key }));
}

/** Deletes change rows written before `before`. */
export function pruneChanges(db: Database, before: string): number {
  return db.query("DELETE FROM changes WHERE at < ?").run(before).changes;
}

type ListedColumns = Pick<SubjectViewRow, "section" | "sort_at" | "stack_id" | "row_json">;

/**
 * Upserts view rows. A `view` change is appended only for subjects whose list-visible
 * columns (`section`, `sort_at`, `stack_id`, `row_json`) differ from the stored row, or
 * that had no row. Returns the keys that changed.
 */
export function putViews(db: Database, views: SubjectViewRecord[], now: string): string[] {
  const current = db.query<ListedColumns, [string]>(
    "SELECT section, sort_at, stack_id, row_json FROM subject_views WHERE subject_key = ?",
  );
  const upsert = db.query(
    `INSERT INTO subject_views (subject_key, pipeline_version, config_hash, section, sort_at,
       score, repo, stack_id, row_json, detail_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (subject_key) DO UPDATE SET
       pipeline_version = excluded.pipeline_version, config_hash = excluded.config_hash,
       section = excluded.section, sort_at = excluded.sort_at, score = excluded.score,
       repo = excluded.repo, stack_id = excluded.stack_id, row_json = excluded.row_json,
       detail_json = excluded.detail_json, computed_at = excluded.computed_at`,
  );
  const changed: string[] = [];
  db.transaction(() => {
    for (const v of views) {
      const rowJson = toJson(v.row);
      const before = current.get(v.subjectKey);
      const listChanged =
        !before ||
        before.row_json !== rowJson ||
        before.section !== v.section ||
        before.sort_at !== v.sortAt ||
        before.stack_id !== v.stackId;
      upsert.run(
        v.subjectKey,
        v.pipelineVersion,
        v.configHash,
        v.section,
        v.sortAt,
        v.score,
        v.repo,
        v.stackId,
        rowJson,
        toJson(v.detail),
        v.computedAt,
      );
      if (listChanged) {
        appendChange(db, "view", v.subjectKey, now);
        changed.push(v.subjectKey);
      }
    }
  })();
  return changed;
}

/** View rows newest first. Rows in the `hidden` section are skipped unless `includeHidden`. */
export function listViews(
  db: Database,
  opts: { includeHidden?: boolean } = {},
): SubjectViewRecord[] {
  const sql = opts.includeHidden
    ? "SELECT * FROM subject_views ORDER BY sort_at DESC, subject_key"
    : "SELECT * FROM subject_views WHERE section <> 'hidden' ORDER BY sort_at DESC, subject_key";
  return db.query<SubjectViewRow, []>(sql).all().map(viewFromRow);
}

export function getView(db: Database, key: string): SubjectViewRecord | undefined {
  const row = db
    .query<SubjectViewRow, [string]>("SELECT * FROM subject_views WHERE subject_key = ?")
    .get(key);
  return row ? viewFromRow(row) : undefined;
}

/**
 * Subjects whose view is missing or was computed with a different pipeline version or
 * config hash.
 */
export function staleViewKeys(db: Database, pipelineVersion: number, configHash: string): string[] {
  return db
    .query<{ subject_key: string }, [number, string]>(
      `SELECT s.subject_key FROM subjects s
       LEFT JOIN subject_views v ON v.subject_key = s.subject_key
       WHERE v.subject_key IS NULL OR v.pipeline_version <> ? OR v.config_hash <> ?
       ORDER BY s.subject_key`,
    )
    .all(pipelineVersion, configHash)
    .map((r) => r.subject_key);
}
