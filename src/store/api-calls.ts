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

/**
 * What `resource` has spent against our hourly cap since `since` (inclusive):
 * summed cost for GraphQL, request count excluding 304s for REST.
 */
export function resourceSpendSince(db: Database, resource: string, since: string): number {
  const sql =
    resource === "graphql"
      ? "SELECT COALESCE(SUM(cost), 0) AS spend FROM api_calls WHERE resource = ? AND at >= ?"
      : `SELECT COUNT(*) AS spend FROM api_calls
         WHERE resource = ? AND at >= ? AND (status IS NULL OR status <> 304)`;
  return db.query<{ spend: number }, [string, string]>(sql).get(resource, since)?.spend ?? 0;
}

export function pruneApiCalls(db: Database, before: string): number {
  return db.query("DELETE FROM api_calls WHERE at < ?").run(before).changes;
}

export interface HourlySpend extends ApiSpend {
  /** `YYYY-MM-DDTHH`, UTC. */
  hour: string;
}

/** Call count and summed cost per UTC hour, resource and work class since `since` (inclusive). */
export function hourlySpendSince(db: Database, since: string): HourlySpend[] {
  return db
    .query<{ hour: string; resource: string; work_class: string; calls: number; cost: number }, [string]>(
      `SELECT substr(at, 1, 13) AS hour, resource, work_class, COUNT(*) AS calls, COALESCE(SUM(cost), 0) AS cost
       FROM api_calls WHERE at >= ?
       GROUP BY hour, resource, work_class ORDER BY hour, resource, work_class`,
    )
    .all(since)
    .map((r) => ({ hour: r.hour, resource: r.resource, workClass: r.work_class, calls: r.calls, cost: r.cost }));
}
