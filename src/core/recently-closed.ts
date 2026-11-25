import type { SubjectState } from "./types.ts";
import type { WsPull } from "./workstreams.ts";

/** How long a PR that left the open listing still counts toward its workstream. */
export const RECENTLY_CLOSED_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClosedPull {
  /** `closed` is always set. */
  pull: WsPull;
  /** When the listing first lacked the PR. */
  closedAt: string;
}

/**
 * The recently-closed list after a new listing: PRs in `previousOpen` but not in `open` join
 * it, PRs that are open again leave it, and entries older than 7 days are dropped.
 * `stateOf` gives the stored subject state for a PR number, when there is a subject; a PR
 * without one is marked `closed`.
 */
export function nextRecentlyClosed(
  previousOpen: readonly WsPull[],
  open: readonly WsPull[],
  prior: readonly ClosedPull[],
  stateOf: (number: number) => SubjectState | null,
  now: Date,
): ClosedPull[] {
  const openNumbers = new Set(open.map((p) => p.number));
  const cutoff = now.getTime() - RECENTLY_CLOSED_MS;
  const out = new Map<number, ClosedPull>();
  for (const c of prior) {
    if (openNumbers.has(c.pull.number) || Date.parse(c.closedAt) < cutoff) continue;
    out.set(c.pull.number, c);
  }
  for (const p of previousOpen) {
    if (openNumbers.has(p.number) || out.has(p.number)) continue;
    out.set(p.number, { pull: { ...p }, closedAt: now.toISOString() });
  }
  for (const c of out.values()) {
    c.pull = { ...c.pull, closed: stateOf(c.pull.number) === "MERGED" ? "merged" : "closed" };
  }
  return [...out.values()].sort((a, b) => a.pull.number - b.pull.number);
}
