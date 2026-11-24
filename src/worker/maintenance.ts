import type { Database } from "bun:sqlite";
import { META } from "../core/meta-keys.ts";
import { pruneApiCalls } from "../store/api-calls.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { pruneStateOps } from "../store/state-ops.ts";
import { pruneChanges } from "../store/views.ts";
import type { Job } from "./scheduler.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const MAINTENANCE_INTERVAL_MS = HOUR_MS;
export const CHANGES_RETENTION_MS = 7 * DAY_MS;
export const API_CALLS_RETENTION_MS = 30 * DAY_MS;
export const STATE_OPS_RETENTION_MS = 30 * DAY_MS;

export interface PruneSummary {
  changes: number;
  apiCalls: number;
  outbox: number;
  stateOps: number;
}

function before(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

/** Deletes old changes, API calls, completed outbox rows and state ops. Failed outbox rows stay. */
export function runMaintenance(db: Database, now: Date): PruneSummary {
  return db.transaction(() => {
    const summary = {
      changes: pruneChanges(db, before(now, CHANGES_RETENTION_MS)),
      apiCalls: pruneApiCalls(db, before(now, API_CALLS_RETENTION_MS)),
      ...pruneStateOps(db, before(now, STATE_OPS_RETENTION_MS)),
    };
    setMeta(db, META.maintenanceAt, now.toISOString(), now.toISOString());
    return summary;
  })();
}

function due(db: Database, now: Date): boolean {
  const last = getMeta(db, META.maintenanceAt);
  return !last || now.getTime() - Date.parse(last) >= MAINTENANCE_INTERVAL_MS;
}

/** Hourly pruning. Reports "idle" so it never keeps `drain()` going. */
export const maintenanceJob: Job = {
  name: "maintenance",
  local: true,
  async run(ctx) {
    const now = ctx.clock();
    if (!due(ctx.db, now)) return "idle";
    const s = runMaintenance(ctx.db, now);
    if (s.changes + s.apiCalls + s.outbox + s.stateOps > 0) {
      ctx.log.info(
        `maintenance: pruned ${s.changes} changes, ${s.apiCalls} API calls, ${s.outbox} outbox rows, ${s.stateOps} state ops`,
      );
    }
    return "idle";
  },
};
