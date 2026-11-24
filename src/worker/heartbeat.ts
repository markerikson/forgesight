import type { Database } from "bun:sqlite";
import { META } from "../core/meta-keys.ts";
import { setMeta } from "../store/meta.ts";

export const HEARTBEAT_MS = 10_000;

/** Writes `worker.heartbeatAt` now and every HEARTBEAT_MS until the returned stop function runs. */
export function startHeartbeat(db: Database, clock: () => Date, intervalMs = HEARTBEAT_MS): () => void {
  const beat = () => {
    const now = clock().toISOString();
    setMeta(db, META.heartbeatAt, now, now);
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
