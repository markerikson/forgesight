/** The parts of a GitHub compare that verdicts read. Structural, so core does not import the GitHub layer. */
export interface CompareFile {
  sha: string | null;
  filename: string;
  status: string;
  patch: string | null;
  previousFilename: string | null;
}

export interface CompareSide {
  mergeBaseSha: string;
  totalCommits: number;
  files: CompareFile[];
}

export type Verdict = "rebase_only" | "noop" | "changed";

/** A stored push verdict: still being checked, decided, or given up on. */
export type PushVerdictKind = Verdict | "pending" | "unknown";

export interface PushVerdict {
  verdict: PushVerdictKind;
  reason: string | null;
  /** The branch the push landed on, when its base was a branch name rather than a commit. */
  onto: string | null;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** A base stored as a branch name names where the push landed; a commit SHA does not. */
export function ontoBranch(baseAfter: string | null): string | null {
  return baseAfter === null || COMMIT_SHA.test(baseAfter) ? null : baseAfter;
}

export interface SideComparison {
  verdict: Verdict;
  reason: string;
}

/** GitHub stops listing files at 300 and commits at 250; past either, the diff is incomplete. */
const MAX_FILES = 300;
const MAX_COMMITS = 250;

/**
 * Keeps only added and removed lines, so hunk offsets and context shifts from a rebase do not count.
 * GitHub's patches start at the first hunk; any `---`/`+++` file header before it is skipped, while
 * changed lines inside hunks that start with `--` or `++` are kept.
 */
export function normalizePatch(patch: string): string {
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  return lines
    .slice(Math.max(firstHunk, 0))
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .join("\n");
}

/** One signature per file: status, rename source, and the changed lines (or the blob SHA when GitHub omits the patch). */
export function fileSigs(files: CompareFile[]): Map<string, string> {
  const sigs = new Map<string, string>();
  for (const f of files) {
    const head = `${f.status}:${f.previousFilename ?? ""}`;
    const body = f.patch === null ? `blob:${f.sha ?? ""}` : normalizePatch(f.patch);
    sigs.set(f.filename, `${head}\n${body}`);
  }
  return sigs;
}

function truncated(side: CompareSide): boolean {
  return side.files.length >= MAX_FILES || side.totalCommits > MAX_COMMITS;
}

/**
 * Compares the PR's diff against its base before and after a push. Equal diffs mean the push only moved
 * the branch onto a new base (`rebase_only`), or changed nothing at all when the merge base also stayed (`noop`).
 * A truncated diff counts as changed, so a missed change is never hidden. Files matching `ignore` may differ
 * without counting.
 */
export function compareSides(
  before: CompareSide,
  after: CompareSide,
  ignore: readonly RegExp[] = [],
): SideComparison {
  if (truncated(before) || truncated(after)) return { verdict: "changed", reason: "truncated" };
  const a = fileSigs(before.files);
  const b = fileSigs(after.files);
  let differing = 0;
  let ignored = 0;
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(name) === b.get(name)) continue;
    if (ignore.some((re) => re.test(name))) ignored++;
    else differing++;
  }
  if (differing > 0) {
    return { verdict: "changed", reason: differing === 1 ? "1 file differs" : `${differing} files differ` };
  }
  const note = ignored === 0 ? "" : ignored === 1 ? " (1 ignored file differs)" : ` (${ignored} ignored files differ)`;
  if (before.mergeBaseSha === after.mergeBaseSha) {
    return { verdict: "noop", reason: `patches equal, same base${note}` };
  }
  return { verdict: "rebase_only", reason: `patches equal${note}` };
}
