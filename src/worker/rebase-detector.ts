import { repoConfig } from "../core/config.ts";
import { compareSides } from "../core/rebase/patch.ts";
import { type BaseSource, baseForPush, needsVerdict, pushHistory } from "../core/rebase/select.ts";
import { GitHubApiError, NotFoundError } from "../github/errors.ts";
import type { Compare, GitHubClient } from "../github/types.ts";
import {
  branchPushes,
  type DecidedVerdict,
  deferVerdict,
  nextPending,
  type PendingPush,
  queuePushes,
  saveVerdict,
  unqueuedPushes,
} from "../store/push-verdicts.ts";
import { getSubject } from "../store/subjects.ts";
import { timelineFor } from "../store/timeline.ts";
import { appendChange } from "../store/views.ts";
import type { Job, JobContext } from "./scheduler.ts";

const BATCH = 10;
export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];

/** Wait before retrying a push whose check failed `attempts` times. */
export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1] ?? 0;
}

interface SideResult {
  compare: Compare;
  base: string;
  note: string | null;
}

/**
 * Compares `head` against `base`. A base given by branch name can 404 once the branch is deleted;
 * the repo's trunks stand in for it then.
 */
async function compareSide(
  gh: GitHubClient,
  repo: string,
  base: string,
  source: BaseSource,
  head: string,
  trunks: string[],
): Promise<SideResult> {
  try {
    return { compare: await gh.compare(repo, base, head), base, note: null };
  } catch (err) {
    if (!(err instanceof NotFoundError) || source !== "ref" || trunks.includes(base)) throw err;
  }
  for (const trunk of trunks) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- stops at the first trunk that exists
      return { compare: await gh.compare(repo, trunk, head), base: trunk, note: `ref 404 -> ${trunk}` };
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  throw new NotFoundError(`compare ${repo} ${base}...${head}: no base found`);
}

async function decide(ctx: JobContext, push: PendingPush): Promise<DecidedVerdict> {
  const { db, gh, config } = ctx;
  const subject = getSubject(db, push.subjectKey);
  if (!subject || !needsVerdict(subject, config) || !subject.baseRef) {
    return { verdict: "unknown", reason: "not checked", baseBefore: null, baseAfter: null };
  }
  const history = pushHistory(timelineFor(db, push.subjectKey));
  const head = history.heads.find((h) => h.id === push.pushNodeId);
  if (!head) return { verdict: "unknown", reason: "push not on timeline", baseBefore: null, baseAfter: null };

  const { trunks, rebaseIgnore } = repoConfig(config, subject.repo);
  const refs = [subject.baseRef, ...history.refChanges.map((c) => c.from)].filter(
    (r): r is string => r !== null && !trunks.includes(r),
  );
  const bases = baseForPush({
    ...history,
    push: head,
    baseRef: subject.baseRef,
    trunks,
    branchPushes: branchPushes(db, subject.repo, [...new Set(refs)]),
  });
  const before = await compareSide(gh, subject.repo, bases.before, bases.source.before, head.before, trunks);
  const after = await compareSide(gh, subject.repo, bases.after, bases.source.after, head.after, trunks);
  const result = compareSides(before.compare, after.compare, rebaseIgnore);
  const notes = [before.note, after.note].filter((n) => n !== null);
  return {
    verdict: result.verdict,
    reason: [...notes, result.reason].join("; "),
    baseBefore: before.base,
    baseAfter: after.base,
  };
}

/**
 * Decides whether each head force-push on an open PR in an overview repo was a rebase with no
 * change of its own. Queues new pushes, then checks up to 10 due ones with two compare calls each.
 * Server errors defer the push with backoff; after 5 failed attempts it is marked unknown.
 */
export const rebaseDetectorJob: Job = {
  name: "rebaseDetector",
  async run(ctx) {
    const { db, governor, config, clock, log } = ctx;
    if (!config.rebase.enabled) return "idle";

    const queued = queuePushes(
      db,
      unqueuedPushes(db).filter((p) => needsVerdict({ kind: "pr", state: "OPEN", repo: p.repo }, config)),
      config.rebase.method,
      clock().toISOString(),
    );

    let checked = 0;
    const counts: Record<string, number> = {};
    for (const push of nextPending(db, clock().toISOString(), BATCH, config.me)) {
      if (!governor.canSpend("rest", "rebase")) break;
      const now = clock();
      let decided: DecidedVerdict;
      try {
        // oxlint-disable-next-line no-await-in-loop -- checks run one at a time so the budget check applies to each
        decided = await decide(ctx, push);
      } catch (err) {
        if (err instanceof NotFoundError) {
          decided = { verdict: "unknown", reason: "not found", baseBefore: null, baseAfter: null };
        } else if (err instanceof GitHubApiError && err.status >= 500 && push.attempts + 1 < MAX_ATTEMPTS) {
          const at = new Date(now.getTime() + backoffMs(push.attempts + 1)).toISOString();
          deferVerdict(db, push.pushNodeId, at, `HTTP ${err.status}`);
          checked++;
          continue;
        } else if (err instanceof GitHubApiError) {
          decided = { verdict: "unknown", reason: `HTTP ${err.status}`, baseBefore: null, baseAfter: null };
        } else {
          throw err;
        }
      }
      saveVerdict(db, push.pushNodeId, decided, now.toISOString());
      appendChange(db, "raw", push.subjectKey, now.toISOString());
      counts[decided.verdict] = (counts[decided.verdict] ?? 0) + 1;
      checked++;
    }

    if (checked > 0 || queued > 0) {
      log.info(`rebase: queued ${queued}, checked ${checked} ${JSON.stringify(counts)}`);
      return "worked";
    }
    return "idle";
  },
};
