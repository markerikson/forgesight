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
  milestoned: "milestone change",
  unknown: "other event",
};

function noun(e: ViewEvent): string {
  const base = NOUNS[e.kind];
  return e.actor?.isBot && (e.kind === "comment" || e.kind === "review") ? `bot ${base}` : base;
}

function isCrossReference(e: ViewEvent): boolean {
  return e.kind === "crossReference";
}

/** Up to two names, then a count of the rest: "alice, bob and 2 others". */
function nameList(names: string[], unnamed: number): string {
  const shown = names.slice(0, 2);
  const rest = names.length - shown.length + unnamed;
  if (rest > 0) return `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
  return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : (shown[0] ?? "");
}

/** Names who made a run of cross-references, so it doesn't read as the author's doing. */
function crossReferenceSummary(events: ViewEvent[]): string {
  const kinds = new Set(events.map((e) => e.data.ref?.kind));
  const from = kinds.size === 1 && kinds.has("pr") ? "PRs" : kinds.size === 1 && kinds.has("issue") ? "issues" : "PRs and issues";
  const names = [...new Set(events.flatMap((e) => (e.actor ? [e.actor.login] : [])))];
  const unnamed = events.some((e) => e.actor === null) ? 1 : 0;
  if (names.length === 0) return `${plural(events.length, "reference")} from other ${from}`;
  if (names.length === 1 && unnamed === 0) return `${names[0]} referenced this from ${events.length} ${from}`;
  return `${plural(events.length, "reference")} from ${nameList(names, unnamed)}`;
}

/**
 * "3 bot comments, 2 cross-references", in order of first appearance. A group of only
 * cross-references names who made them: "alice referenced this from 3 PRs".
 */
export function groupSummary(events: ViewEvent[]): string {
  if (events.length > 1 && events.every(isCrossReference)) return crossReferenceSummary(events);
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

/**
 * A run of collapsed events as group entries. Two or more cross-references get a group of
 * their own after the rest, so a stack tool's dozens of references don't bury the other events.
 */
function groupEntries(items: ViewEvent[]): RoundEntry[] {
  const refs = items.filter(isCrossReference);
  const split = refs.length >= 2 && refs.length < items.length;
  const groups = split ? [items.filter((e) => !isCrossReference(e)), refs] : [items];
  return groups.filter((g) => g.length > 0).map((g) => ({ type: "group", group: makeGroup(g) }));
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
    entries.push(...groupEntries(pending));
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
    entries: groupEntries(collapsed),
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
