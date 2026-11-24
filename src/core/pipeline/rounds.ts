import { plural } from "./text.ts";
import { ms } from "./time.ts";
import type { CollapsedGroup, EventKind, Round, RoundEntry, ViewEvent } from "./types.ts";

/** Commits pushed within this gap of the previous commit belong to the same push. */
const COMMIT_BATCH_MS = 10 * 60_000;

const NOUNS: Record<EventKind, string> = {
  comment: "comment",
  review: "review",
  reviewComment: "review comment",
  commit: "commit",
  forcePush: "force-push",
  baseForcePush: "base force-push",
  merged: "merge",
  closed: "close",
  reopened: "reopen",
  readyForReview: "ready for review",
  convertToDraft: "draft conversion",
  reviewRequested: "review request",
  reviewRequestRemoved: "removed review request",
  reviewDismissed: "dismissed review",
  crossReference: "cross-reference",
  reference: "commit reference",
  renamed: "rename",
  baseChanged: "base change",
  labeled: "label change",
  assigned: "assignment",
  mentioned: "mention",
  stack: "stack change",
  connected: "linked issue",
  closedByPr: "close",
  markedDuplicate: "duplicate mark",
  transferred: "transfer",
  subIssue: "sub-issue change",
  unknown: "other event",
};

function noun(e: ViewEvent): string {
  const base = NOUNS[e.kind];
  return e.actor?.isBot && (e.kind === "comment" || e.kind === "review") ? `bot ${base}` : base;
}

/** "3 bot comments, 2 cross-references", in order of first appearance. */
export function groupSummary(events: ViewEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    const n = noun(e);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts].map(([n, c]) => plural(c, n)).join(", ");
}

function makeGroup(items: ViewEvent[]): CollapsedGroup {
  return { summary: groupSummary(items), items, isNew: items.some((e) => e.isNew) };
}

interface RoundBuilder {
  startedBy: ViewEvent | null;
  startedAt: string;
  commits: ViewEvent[];
  lastCommitAt: number | null;
  events: ViewEvent[];
}

function finish(b: RoundBuilder): Round {
  const entries: RoundEntry[] = [];
  let pending: ViewEvent[] = [];
  let hiddenCount = 0;
  const flush = () => {
    if (pending.length > 0) entries.push({ type: "group", group: makeGroup(pending) });
    pending = [];
  };
  for (const e of b.events) {
    if (e.level === "hidden") hiddenCount++;
    else if (e.level === "collapsed") pending.push(e);
    else {
      flush();
      entries.push({ type: "event", event: e });
    }
  }
  flush();
  let startLabel: string | null = null;
  if (b.startedBy?.kind === "forcePush") startLabel = "force-pushed";
  else if (b.startedBy?.kind === "commit") startLabel = `pushed ${plural(b.commits.length, "commit")}`;
  return {
    startedBy: b.startedBy,
    startLabel,
    startedAt: b.startedAt,
    pushCount: b.startedBy ? 1 : 0,
    commits: b.commits,
    entries,
    hiddenCount,
    isNew: (b.startedBy?.isNew ?? false) || b.commits.some((e) => e.isNew) || b.events.some((e) => e.isNew),
  };
}

/** A round opened by a push with nothing shown in it, only collapsed or hidden events. */
function isPushOnly(r: Round): boolean {
  return r.startedBy !== null && r.entries.every((e) => e.type === "group");
}

/** Consecutive push-only rounds (oldest first) as one round labelled "5 pushes, no other activity". */
function mergeRun(run: Round[]): Round {
  const first = run[0];
  if (!first || run.length === 1) return first as Round;
  const collapsed = run.flatMap((r) => r.entries.flatMap((e) => (e.type === "group" ? e.group.items : [])));
  const pushCount = run.reduce((n, r) => n + r.pushCount, 0);
  return {
    startedBy: first.startedBy,
    startLabel: collapsed.length > 0 ? plural(pushCount, "push") : `${plural(pushCount, "push")}, no other activity`,
    startedAt: first.startedAt,
    pushCount,
    commits: run.flatMap((r) => r.commits),
    entries: collapsed.length > 0 ? [{ type: "group", group: makeGroup(collapsed) }] : [],
    hiddenCount: run.reduce((n, r) => n + r.hiddenCount, 0),
    isNew: run.some((r) => r.isNew),
  };
}

function mergePushOnly(rounds: Round[]): Round[] {
  const out: Round[] = [];
  let run: Round[] = [];
  const flush = () => {
    if (run.length > 0) out.push(mergeRun(run));
    run = [];
  };
  for (const r of rounds) {
    if (isPushOnly(r)) {
      run.push(r);
    } else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

/**
 * Splits events (oldest first) into review rounds, returned newest first. A round starts at
 * each force-push and at each batch of commits; commits within 10 minutes of the previous
 * commit join its batch unless a visible event came in between. Inside a round, runs of collapsed events between shown events
 * become one group; hidden events are only counted. Consecutive rounds with nothing shown
 * merge into one, so a run of rebases reads as "5 pushes". Every force-push counts as real until
 * push verdicts exist.
 */
export function buildRounds(events: ViewEvent[]): Round[] {
  const rounds: Round[] = [];
  let current: RoundBuilder | null = null;
  const start = (e: ViewEvent): RoundBuilder => {
    if (current && (current.startedBy !== null || current.events.length > 0)) rounds.push(finish(current));
    return { startedBy: e, startedAt: e.at, commits: e.kind === "commit" ? [e] : [], lastCommitAt: null, events: [] };
  };

  for (const e of events) {
    if (e.kind === "forcePush") {
      current = start(e);
      continue;
    }
    if (e.kind === "commit") {
      const at = ms(e.at);
      const inBatch =
        current !== null &&
        current.startedBy?.kind === "commit" &&
        current.lastCommitAt !== null &&
        at - current.lastCommitAt <= COMMIT_BATCH_MS &&
        current.events.every((x) => x.level === "hidden");
      if (current && inBatch) {
        current.commits.push(e);
        current.lastCommitAt = at;
      } else {
        current = start(e);
        current.lastCommitAt = at;
      }
      continue;
    }
    current ??= { startedBy: null, startedAt: e.at, commits: [], lastCommitAt: null, events: [] };
    current.events.push(e);
  }
  if (current) rounds.push(finish(current));
  return mergePushOnly(rounds).reverse();
}
