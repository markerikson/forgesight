/** `meta` keys shared by the worker, which writes them, and the web process, which reads them. */
export const META = {
  workerStatus: "worker.status",
  heartbeatAt: "worker.heartbeatAt",
  viewerLogin: "viewer.login",
  etag: "notifications.etag",
  nextPollAt: "notifications.nextPollAt",
  /** Anchor of the `since=` window for the next changed poll. */
  lastPollStartedAt: "notifications.lastPollStartedAt",
  lastFullAt: "notifications.lastFullAt",
  /** Last page-1 check; a `poll.requestedAt` newer than this is still pending. */
  lastCheckAt: "notifications.lastCheckAt",
  pollRequestedAt: "poll.requestedAt",
  backfillStartedAt: "backfill.startedAt",
  backfillCursor: "backfill.cursor",
  backfillCompletedAt: "backfill.completedAt",
  /** Highest `changes.seq` the derive job has consumed. */
  deriveSeq: "derive.seq",
  /** Time of the last derive run; snoozes that ended since then are re-derived. */
  deriveAt: "derive.at",
  /** JSON list of subject keys whose last derive threw; retried on the next run. */
  deriveFailed: "derive.failed",
  /** Time of the last maintenance run, which prunes old changes, API calls and state ops. */
  maintenanceAt: "maintenance.at",
} as const;

/** Adaptive SubjectBatch state for one repo, stored as JSON `BatchState`. */
export function batchMetaKey(repo: string): string {
  return `batch.${repo}`;
}

/** Latest open-PR listing for one full-mode repo, stored as JSON `OpenPullsListing`. */
export function openPullsMetaKey(repo: string): string {
  return `openPulls.${repo}`;
}

/** PRs that left the open listing in the last 7 days, stored as JSON `ClosedPull[]`. */
export function recentlyClosedMetaKey(repo: string): string {
  return `openPulls.${repo}.recentlyClosed`;
}
