import type { Database } from "bun:sqlite";
import { META } from "../core/meta-keys.ts";
import { getMeta } from "../store/meta.ts";

/** Meta keys the web reads for worker status. */
export const WORKER_META = {
  status: META.workerStatus,
  heartbeatAt: META.heartbeatAt,
  viewerLogin: META.viewerLogin,
  lastPollStartedAt: META.lastPollStartedAt,
  lastCheckAt: META.lastCheckAt,
  lastFullAt: META.lastFullAt,
  nextPollAt: META.nextPollAt,
  backfillStartedAt: META.backfillStartedAt,
  backfillCursor: META.backfillCursor,
  backfillCompletedAt: META.backfillCompletedAt,
} as const;

export type WorkerMetaKey = keyof typeof WORKER_META;

export function readWorkerMeta(db: Database): Record<WorkerMetaKey, string | null> {
  const out = {} as Record<WorkerMetaKey, string | null>;
  for (const [name, key] of Object.entries(WORKER_META)) {
    out[name as WorkerMetaKey] = getMeta(db, key) ?? null;
  }
  return out;
}

export interface EnrichQueue {
  pending: number;
  failing: number;
}

export function enrichQueue(db: Database): EnrichQueue {
  const row = db
    .query<{ pending: number; failing: number }, []>(
      `SELECT
         COUNT(*) FILTER (WHERE dirty_at IS NOT NULL) AS pending,
         COUNT(*) FILTER (WHERE enrich_error IS NOT NULL) AS failing
       FROM subjects`,
    )
    .get();
  return { pending: row?.pending ?? 0, failing: row?.failing ?? 0 };
}
