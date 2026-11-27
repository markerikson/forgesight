export type Resource = "rest" | "graphql";

/** Kinds of GitHub work, highest priority first. */
export type WorkClass =
  | "notifications"
  | "enrich"
  | "writeback"
  | "openPulls"
  | "rebase"
  | "doneSync"
  | "backfill";

export const WORK_CLASSES: readonly WorkClass[] = [
  "notifications",
  "enrich",
  "writeback",
  "openPulls",
  "rebase",
  "doneSync",
  "backfill",
];

/** Above this fraction of the hourly cap, only notifications, enrich and writeback run. */
export const SOFT_CAP_FRACTION = 0.8;
/** Below this many requests left in GitHub's own window, only notifications and writeback run. */
export const LOW_REMAINING = 500;

const SOFT_CAP_CLASSES: readonly WorkClass[] = ["notifications", "enrich", "writeback"];
const ESSENTIAL_CLASSES: readonly WorkClass[] = ["notifications", "writeback"];

/** GitHub's own counter for a resource, from the last response headers or `rateLimit` field. */
export interface RemainingQuota {
  remaining: number;
  resetAt: Date;
}

export interface BudgetState {
  /** Our spend on this resource over the last hour. */
  spend: number;
  /** Our hourly cap for this resource. */
  cap: number;
  remaining: RemainingQuota | null;
  /** Set after a secondary rate limit; nothing runs until it passes. */
  pausedUntil: Date | null;
}

/** Which work classes may spend on one resource right now. */
export function decideAllowed(state: BudgetState, now: Date): Set<WorkClass> {
  if (state.pausedUntil && now < state.pausedUntil) return new Set();

  let allowed: readonly WorkClass[];
  if (state.spend < state.cap * SOFT_CAP_FRACTION) allowed = WORK_CLASSES;
  else if (state.spend < state.cap) allowed = SOFT_CAP_CLASSES;
  else allowed = ESSENTIAL_CLASSES;

  const { remaining } = state;
  if (remaining && now < remaining.resetAt) {
    if (remaining.remaining <= 0) return new Set();
    if (remaining.remaining < LOW_REMAINING) {
      allowed = allowed.filter((c) => ESSENTIAL_CLASSES.includes(c));
    }
  }
  return new Set(allowed);
}
