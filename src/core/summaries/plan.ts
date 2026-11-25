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

/**
 * Member numbers whose text needs fetching: never stored, or the PR listing shows an update after
 * the stored copy. Members missing from the listing (closed PRs) are fetched once.
 */
export function prTextsToFetch(
  numbers: readonly number[],
  stored: ReadonlyMap<number, { updatedAt: string }>,
  listed: ReadonlyMap<number, { updatedAt: string }>,
): number[] {
  return numbers.filter((n) => {
    const have = stored.get(n);
    if (!have) return true;
    const seen = listed.get(n);
    return seen !== undefined && Date.parse(seen.updatedAt) > Date.parse(have.updatedAt);
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
