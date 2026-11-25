/** A workstream's summary refreshes at most this often, except for its first summary. */
export const SUMMARY_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type SummaryDecision = "current" | "queue" | "wait";

/**
 * Whether to queue a summary for a request with `inputHash`. The first summary is queued right
 * away; later ones wait until the newest summary is `SUMMARY_MIN_INTERVAL_MS` old.
 */
export function summaryDecision(
  latest: { inputHash: string; createdAt: string } | null,
  inputHash: string,
  now: Date,
): SummaryDecision {
  if (!latest) return "queue";
  if (latest.inputHash === inputHash) return "current";
  const age = now.getTime() - Date.parse(latest.createdAt);
  return age >= SUMMARY_MIN_INTERVAL_MS ? "queue" : "wait";
}

/** The open PR listing for one repo: when it was fetched and the PRs it holds. */
export interface ListedPulls {
  fetchedAt: string | null;
  pulls: ReadonlyMap<number, { updatedAt: string }>;
}

/**
 * Member numbers whose text needs fetching: never stored, or the PR listing shows an update after
 * the stored copy, or the stored copy says open but a listing fetched after it no longer has the
 * PR (it closed or merged, so its stored state is out of date).
 */
export function prTextsToFetch(
  numbers: readonly number[],
  stored: ReadonlyMap<number, { updatedAt: string; fetchedAt: string; state: string | null }>,
  listed: ListedPulls,
): number[] {
  return numbers.filter((n) => {
    const have = stored.get(n);
    if (!have) return true;
    const seen = listed.pulls.get(n);
    if (seen) return Date.parse(seen.updatedAt) > Date.parse(have.updatedAt);
    return (
      have.state !== "CLOSED" &&
      have.state !== "MERGED" &&
      listed.fetchedAt !== null &&
      Date.parse(listed.fetchedAt) > Date.parse(have.fetchedAt)
    );
  });
}

/** Delay before retry `attempt` (1-based) of a failed LLM call: 1, 4, 16 minutes. */
export function llmRetryDelayMs(attempt: number): number {
  return 60_000 * 4 ** Math.max(0, attempt - 1);
}

export function subjectNumber(subjectKey: string): number | null {
  const hash = subjectKey.lastIndexOf("#");
  if (hash < 0) return null;
  const n = Number(subjectKey.slice(hash + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
}
