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

/** A stored PR subject, as the enrichment last saw it. */
export interface StoredPull {
  /** `closed` is never set; `state` says whether the PR is open. */
  pull: WsPull;
  state: SubjectState;
  /** From the payload: merge or close time; null while open. */
  closedAt: string | null;
}

export interface GroupingPullsInput {
  open: readonly WsPull[];
  /** When `open` was fetched. */
  listedAt: string;
  recentlyClosed: readonly ClosedPull[];
  stored: readonly StoredPull[];
  now: Date;
}

/**
 * The PRs to group: the open listing, the recently-closed list, and stored PR subjects the
 * listings missed. A stored PR closed or merged within 7 days joins as closed; that covers PRs
 * closed before the first listing or opened and closed between two listings, and replaces a
 * listed open PR when it closed after the listing was fetched. A stored PR that
 * is open and was updated after the listing was fetched joins as open, and replaces a
 * recently-closed entry that is older than that update (a reopened PR).
 */
export function groupingPulls(input: GroupingPullsInput): WsPull[] {
  const cutoff = input.now.getTime() - RECENTLY_CLOSED_MS;
  const listedAt = Date.parse(input.listedAt);
  const out = new Map<number, WsPull>();
  for (const p of input.open) out.set(p.number, p);
  const closedAt = new Map<number, number>();
  for (const c of input.recentlyClosed) {
    if (out.has(c.pull.number)) continue;
    out.set(c.pull.number, { ...c.pull, closedAt: c.closedAt });
    closedAt.set(c.pull.number, Date.parse(c.closedAt));
  }
  for (const s of input.stored) {
    const n = s.pull.number;
    const listed = out.get(n);
    if (s.state === "OPEN") {
      const updated = Date.parse(s.pull.updatedAt);
      if (!(updated > listedAt)) continue;
      if (listed && !listed.closed) continue;
      if (listed && !(updated > (closedAt.get(n) ?? Infinity))) continue;
      out.set(n, { ...s.pull });
    } else {
      if (s.closedAt === null || Date.parse(s.closedAt) < cutoff) continue;
      if (listed && (listed.closed || !(Date.parse(s.closedAt) > listedAt))) continue;
      out.set(n, { ...s.pull, closed: s.state === "MERGED" ? "merged" : "closed", closedAt: s.closedAt });
    }
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}
