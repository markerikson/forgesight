import type { FindingSeverity } from "./types.ts";

const WEIGHT: Record<FindingSeverity, number> = {
  blocker: 4,
  critical: 4,
  "should-fix": 3,
  major: 3,
  "nice-to-have": 2,
  minor: 2,
  question: 1,
  trivial: 1,
  unknown: 0,
};

export function severityWeight(s: FindingSeverity): number {
  return WEIGHT[s];
}

/** Raises Waiting on a reviewed PR: DiffLoupe blocker or should-fix, CodeRabbit critical or major. */
export function isSerious(s: FindingSeverity): boolean {
  return WEIGHT[s] >= 3;
}

export function worstSeverity(list: readonly FindingSeverity[]): FindingSeverity {
  let worst: FindingSeverity = "unknown";
  for (const s of list) if (WEIGHT[s] > WEIGHT[worst]) worst = s;
  return worst;
}

function isSeverity(s: string): s is FindingSeverity {
  return Object.hasOwn(WEIGHT, s);
}

export function toSeverity(raw: string | undefined): FindingSeverity {
  const s = (raw ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return isSeverity(s) ? s : "unknown";
}
