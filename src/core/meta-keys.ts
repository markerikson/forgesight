/** `meta` keys shared by the worker, which writes them, and the web process, which reads them. */
export const META = {
  workerStatus: "worker.status",
  /** Why GitHub rejected the token, while `worker.status` is "auth_failed". */
  authError: "worker.authError",
  /** When the worker next retries the token, while `worker.status` is "auth_failed". */
  authRetryAt: "worker.authRetryAt",
  heartbeatAt: "worker.heartbeatAt",
  viewerLogin: "viewer.login",
  /** "1" when the running worker completes outbox rows without sending them to GitHub. */
  outboxDryRun: "outbox.dryRun",
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
  /** Time of the last check for threads marked done outside Forgesight. */
  doneSyncAt: "doneSync.at",
  /** JSON map of threads missing from the GitHub inbox that the done listing did not confirm. */
  doneSyncUnconfirmed: "doneSync.unconfirmed",
} as const;

/** Adaptive SubjectBatch state for one repo, stored as JSON `BatchState`. */
export function batchMetaKey(repo: string): string {
  return `batch.${repo}`;
}

/** Latest open-PR listing for one full-mode repo, stored as JSON `OpenPullsListing`. */
export function openPullsMetaKey(repo: string): string {
  return `openPulls.${repo}`;
}

/** Time of the first workstream build for one repo, written once. */
export function firstWorkstreamBuildMetaKey(repo: string): string {
  return `workstreams.${repo}.firstBuildAt`;
}

/** PRs that left the open listing in the last 7 days, stored as JSON `ClosedPull[]`. */
export function recentlyClosedMetaKey(repo: string): string {
  return `openPulls.${repo}.recentlyClosed`;
}
