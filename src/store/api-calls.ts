import type { Database } from "bun:sqlite";

export interface ApiCallRecord {
  at: string;
  resource: string;
  workClass: string;
  request: string;
  status: number | null;
  cost: number | null;
  remaining: number | null;
  resetAt: string | null;
  durationMs: number | null;
}

export interface ApiSpend {
  resource: string;
  workClass: string;
  calls: number;
  cost: number;
}

export function recordApiCall(db: Database, call: ApiCallRecord): void {
  db.query(
    `INSERT INTO api_calls (at, resource, work_class, request, status, cost, remaining,
       reset_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    call.at,
    call.resource,
    call.workClass,
    call.request,
    call.status,
    call.cost,
    call.remaining,
    call.resetAt,
    call.durationMs,
  );
}

/** Call count and summed cost per resource and work class since `since` (inclusive). */
export function spendSince(db: Database, since: string): ApiSpend[] {
  return db
    .query<{ resource: string; work_class: string; calls: number; cost: number }, [string]>(
      `SELECT resource, work_class, COUNT(*) AS calls, COALESCE(SUM(cost), 0) AS cost
       FROM api_calls WHERE at >= ?
       GROUP BY resource, work_class ORDER BY resource, work_class`,
    )
    .all(since)
    .map((r) => ({ resource: r.resource, workClass: r.work_class, calls: r.calls, cost: r.cost }));
}

export function pruneApiCalls(db: Database, before: string): number {
  return db.query("DELETE FROM api_calls WHERE at < ?").run(before).changes;
}
