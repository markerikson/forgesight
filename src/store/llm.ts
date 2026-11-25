import type { Database } from "bun:sqlite";
import type { LlmUsage } from "../core/summaries/cost.ts";

export type LlmJobKind = "workstream";
export type LlmJobStatus = "queued" | "running" | "done" | "failed" | "superseded";

export interface LlmJobRecord {
  id: number;
  kind: LlmJobKind;
  subjectKey: string;
  inputHash: string;
  requestJson: string;
  status: LlmJobStatus;
  attempts: number;
  error: string | null;
  runAfter: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface LlmJobRow {
  id: number;
  kind: LlmJobKind;
  subject_key: string;
  input_hash: string;
  request_json: string;
  status: LlmJobStatus;
  attempts: number;
  error: string | null;
  run_after: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toJob(row: LlmJobRow): LlmJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    subjectKey: row.subject_key,
    inputHash: row.input_hash,
    requestJson: row.request_json,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    runAfter: row.run_after,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface EnqueueLlmJob {
  kind: LlmJobKind;
  subjectKey: string;
  inputHash: string;
  requestJson: string;
}

/**
 * Queues a job unless one for the same input is already queued or running.
 * Queued jobs for the same subject with a different input are superseded.
 */
export function enqueueLlmJob(db: Database, job: EnqueueLlmJob, now: string): number {
  return db.transaction(() => {
    db.query(
      `UPDATE llm_jobs SET status = 'superseded', finished_at = ?
       WHERE kind = ? AND subject_key = ? AND status = 'queued' AND input_hash != ?`,
    ).run(now, job.kind, job.subjectKey, job.inputHash);
    const live = db
      .query<{ id: number }, [string, string, string]>(
        `SELECT id FROM llm_jobs
         WHERE kind = ? AND subject_key = ? AND input_hash = ? AND status IN ('queued', 'running')`,
      )
      .get(job.kind, job.subjectKey, job.inputHash);
    if (live) return live.id;
    const row = db
      .query<{ id: number }, [string, string, string, string, string, string]>(
        `INSERT INTO llm_jobs (kind, subject_key, input_hash, request_json, status, run_after, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?) RETURNING id`,
      )
      .get(job.kind, job.subjectKey, job.inputHash, job.requestJson, now, now);
    if (!row) throw new Error("llm_jobs insert returned no row");
    return row.id;
  })();
}

/** Marks up to `limit` due queued jobs as running, oldest first, and returns them. */
export function claimLlmJobs(db: Database, now: string, limit: number): LlmJobRecord[] {
  return db.transaction(() => {
    const rows = db
      .query<LlmJobRow, [string, number]>(
        `SELECT * FROM llm_jobs WHERE status = 'queued' AND run_after <= ? ORDER BY id LIMIT ?`,
      )
      .all(now, limit);
    const claim = db.query(
      `UPDATE llm_jobs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?`,
    );
    for (const r of rows) claim.run(now, r.id);
    return rows.map((r) => toJob({ ...r, status: "running", attempts: r.attempts + 1, started_at: now }));
  })();
}

/** Returns jobs left running by a worker that died mid-call to the queue. */
export function requeueStaleLlmJobs(db: Database, startedBefore: string): number {
  return db
    .query(`UPDATE llm_jobs SET status = 'queued' WHERE status = 'running' AND started_at < ?`)
    .run(startedBefore).changes;
}

export function completeLlmJob(db: Database, id: number, now: string): void {
  db.query(`UPDATE llm_jobs SET status = 'done', error = NULL, finished_at = ? WHERE id = ?`).run(
    now,
    id,
  );
}

/** Requeues the job at `retryAt`, or fails it for good when `retryAt` is null. */
export function failLlmJob(
  db: Database,
  id: number,
  error: string,
  now: string,
  retryAt: string | null,
): void {
  if (retryAt === null) {
    db.query(`UPDATE llm_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      error,
      now,
      id,
    );
  } else {
    db.query(`UPDATE llm_jobs SET status = 'queued', error = ?, run_after = ? WHERE id = ?`).run(
      error,
      retryAt,
      id,
    );
  }
}

export function getLlmJob(db: Database, id: number): LlmJobRecord | null {
  const row = db.query<LlmJobRow, [number]>("SELECT * FROM llm_jobs WHERE id = ?").get(id);
  return row ? toJob(row) : null;
}

/** The newest job for an input, in any status. */
export function lastLlmJobFor(
  db: Database,
  kind: LlmJobKind,
  subjectKey: string,
  inputHash: string,
): LlmJobRecord | null {
  const row = db
    .query<LlmJobRow, [string, string, string]>(
      `SELECT * FROM llm_jobs WHERE kind = ? AND subject_key = ? AND input_hash = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(kind, subjectKey, inputHash);
  return row ? toJob(row) : null;
}

export interface LlmCallRecord {
  jobId: number | null;
  kind: LlmJobKind;
  model: string;
  usage: LlmUsage;
  costUsd: number;
  durationMs: number | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
}

export function recordLlmCall(db: Database, call: LlmCallRecord): void {
  db.query(
    `INSERT INTO llm_calls (job_id, kind, model, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cost_usd, duration_ms, ok, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    call.jobId,
    call.kind,
    call.model,
    call.usage.input,
    call.usage.output,
    call.usage.cacheRead,
    call.usage.cacheWrite,
    call.costUsd,
    call.durationMs,
    call.ok ? 1 : 0,
    call.error,
    call.createdAt,
  );
}

/** Total LLM spend in USD for calls made at or after `since`. */
export function llmSpendSince(db: Database, since: string): number {
  const row = db
    .query<{ total: number | null }, [string]>(
      "SELECT SUM(cost_usd) AS total FROM llm_calls WHERE created_at >= ?",
    )
    .get(since);
  return row?.total ?? 0;
}

export interface SummaryRecord {
  kind: LlmJobKind;
  subjectKey: string;
  inputHash: string;
  promptVersion: number;
  model: string;
  name: string | null;
  text: string;
  status: string | null;
  outputJson: string;
  costUsd: number;
  createdAt: string;
}

interface SummaryRow {
  kind: LlmJobKind;
  subject_key: string;
  input_hash: string;
  prompt_version: number;
  model: string;
  name: string | null;
  text: string;
  status: string | null;
  output_json: string;
  cost_usd: number;
  created_at: string;
}

function toSummary(row: SummaryRow): SummaryRecord {
  return {
    kind: row.kind,
    subjectKey: row.subject_key,
    inputHash: row.input_hash,
    promptVersion: row.prompt_version,
    model: row.model,
    name: row.name,
    text: row.text,
    status: row.status,
    outputJson: row.output_json,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  };
}

export function saveSummary(db: Database, s: SummaryRecord): void {
  db.query(
    `INSERT INTO summaries (kind, subject_key, input_hash, prompt_version, model, name, text, status,
       output_json, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, subject_key, input_hash) DO UPDATE SET
       prompt_version = excluded.prompt_version, model = excluded.model, name = excluded.name,
       text = excluded.text, status = excluded.status, output_json = excluded.output_json,
       cost_usd = excluded.cost_usd, created_at = excluded.created_at`,
  ).run(
    s.kind,
    s.subjectKey,
    s.inputHash,
    s.promptVersion,
    s.model,
    s.name,
    s.text,
    s.status,
    s.outputJson,
    s.costUsd,
    s.createdAt,
  );
}

export function latestSummary(
  db: Database,
  kind: LlmJobKind,
  subjectKey: string,
): SummaryRecord | null {
  const row = db
    .query<SummaryRow, [string, string]>(
      `SELECT * FROM summaries WHERE kind = ? AND subject_key = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(kind, subjectKey);
  return row ? toSummary(row) : null;
}

export interface WorkstreamSummaryView {
  name: string | null;
  text: string;
  status: string | null;
  generatedAt: string;
  inputHash: string;
}

/** Newest summary per workstream id. Pass `ids` to limit the lookup to shown workstreams. */
export function latestWorkstreamSummaries(
  db: Database,
  ids?: readonly string[],
): Map<string, WorkstreamSummaryView> {
  const rows = db
    .query<SummaryRow, []>(
      `SELECT s.* FROM summaries s
       WHERE s.kind = 'workstream' AND s.id = (
         SELECT id FROM summaries
         WHERE kind = 'workstream' AND subject_key = s.subject_key
         ORDER BY created_at DESC, id DESC LIMIT 1
       )`,
    )
    .all();
  const wanted = ids ? new Set(ids) : null;
  const out = new Map<string, WorkstreamSummaryView>();
  for (const r of rows) {
    if (wanted && !wanted.has(r.subject_key)) continue;
    out.set(r.subject_key, {
      name: r.name,
      text: r.text,
      status: r.status,
      generatedAt: r.created_at,
      inputHash: r.input_hash,
    });
  }
  return out;
}
