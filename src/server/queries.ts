import type { Database } from "bun:sqlite";
import { getMeta } from "../store/meta.ts";

/**
 * Meta keys the worker writes. The worker defines them next to its own code; these copies
 * keep the web process from importing worker modules.
 */
export const WORKER_META = {
  status: "worker.status",
  heartbeatAt: "worker.heartbeatAt",
  viewerLogin: "viewer.login",
  lastPollStartedAt: "notifications.lastPollStartedAt",
  lastCheckAt: "notifications.lastCheckAt",
  lastFullAt: "notifications.lastFullAt",
  nextPollAt: "notifications.nextPollAt",
  backfillStartedAt: "backfill.startedAt",
  backfillCursor: "backfill.cursor",
  backfillCompletedAt: "backfill.completedAt",
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
