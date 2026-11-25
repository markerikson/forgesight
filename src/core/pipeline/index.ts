import { type Config, repoConfig } from "../config.ts";
import type {
  ItemState,
  ReviewThreadRecord,
  StickyCommentVersion,
  SubjectRecord,
  ThreadRecord,
  TimelineItemRecord,
} from "../types.ts";
import type { StackContext } from "../workstreams.ts";
import { classify, isMe } from "./classify.ts";
import { normalize } from "./normalize.ts";
import { applyOverrides, type Rank, rank } from "./rank.ts";
import { buildRounds } from "./rounds.ts";
import { buildHeader, buildLinks, subjectBody } from "./row.ts";
import { isAfter } from "./time.ts";
import type { RankReason, Round, Section, SubjectView, ViewEvent } from "./types.ts";

export { describe } from "./rank.ts";
export { subjectBody, toInboxRow, toViewRecord } from "./row.ts";

/** Bump when derive output changes so every stored view is recomputed. */
export const PIPELINE_VERSION = 4;

export interface DeriveInput {
  subject: SubjectRecord;
  threads: ThreadRecord[];
  items: TimelineItemRecord[];
  reviewThreads: ReviewThreadRecord[];
  stickies: StickyCommentVersion[];
  state: ItemState;
  config: Config;
  me: string | null;
  now: Date;
  /** The subject's place in its workstream, when it belongs to one. */
  stack?: StackContext | null;
}

const THREAD_WAITING: Record<string, RankReason> = {
  review_requested: "reviewRequested",
  mention: "mentioned",
  team_mention: "mentioned",
  assign: "assigned",
};

const THREAD_REASON_LINES: Record<string, string> = {
  review_requested: "review requested",
  mention: "mentioned you",
  team_mention: "mentioned your team",
  assign: "assigned to you",
  author: "your thread",
  comment: "you commented",
  state_change: "you changed its state",
  manual: "you subscribed",
};

/** Watching the repo is why most threads arrive, so that reason says nothing. */
function threadReasonLine(reason: string): string {
  if (reason === "subscribed") return "";
  return THREAD_REASON_LINES[reason] ?? reason.replaceAll("_", " ");
}

/** Unread on GitHub and updated after the last dismissal, so it ranks as an update. */
function isFreshUnread(thread: ThreadRecord, state: ItemState): boolean {
  return thread.unread && (state.dismissedAt === null || isAfter(thread.updatedAt, state.dismissedAt));
}

/**
 * Unread on GitHub and updated after the last local read or done. A local read clears the
 * flag right away, before the outbox marks the thread read on GitHub. Uses `readAt`, not
 * `dismissedAt`, so a thread backfill dismissed without reading still shows unread.
 */
function isUnreadHere(thread: ThreadRecord, state: ItemState): boolean {
  return thread.unread && (state.readAt === null || isAfter(thread.updatedAt, state.readAt));
}

/**
 * Rank for a subject enrichment has not reached yet: only the notification threads are
 * known, so an unread thread newer than the last visit counts as an update.
 */
function rankFromThreads(input: DeriveInput): Rank {
  const { threads, state } = input;
  const fresh = threads.filter((t) => isFreshUnread(t, state));
  const newest = fresh.toSorted((a, b) => (isAfter(a.updatedAt, b.updatedAt) ? -1 : 1))[0];
  const reasons: RankReason[] = [];
  let section: Section = "hidden";
  if (newest) {
    const waiting = THREAD_WAITING[newest.reason];
    section = waiting ? "waiting" : "updates";
    if (waiting) reasons.push(waiting);
    reasons.push("notEnriched");
  } else {
    reasons.push("nothingNew");
  }
  const sortAt =
    newest?.updatedAt ??
    threads.map((t) => t.updatedAt).toSorted().at(-1) ??
    input.subject.updatedAt ??
    "1970-01-01T00:00:00Z";
  return {
    section,
    reasons,
    score: 0,
    newMeaningfulCount: 0,
    summaryLine: newest ? threadReasonLine(newest.reason) : "",
    hiddenStats: { pushes: 0, merged: 0, closed: 0 },
    sortAt,
  };
}

/**
 * Pure derivation from stored GitHub data and local state to one subject's view. Same input,
 * same output: `now`, `config` and `me` are passed in.
 */
export function deriveSubjectView(input: DeriveInput): SubjectView {
  const { subject, threads, state, config, me, now } = input;
  const events = classify(normalize({ repo: subject.repo, items: input.items, stickies: input.stickies }), {
    config,
    me,
    mode: repoConfig(config, subject.repo).mode,
    subjectKind: subject.kind,
    mySubject: isMe(subject.author ?? undefined, me),
    dismissedAt: state.dismissedAt,
  });
  const allRounds = buildRounds(events);
  const shown = onlyNewestRoundIfUnvisited(subject, state, events, allRounds);
  const rounds = shown.rounds;
  const enriched = subject.timelineSyncedUntil !== null || events.length > 0;
  const ranked = enriched
    ? {
        ...rank({
          subject,
          threads,
          events,
          rounds: allRounds,
          state,
          me,
          now,
          reviewRequestMaxAgeDays: config.ranking.reviewRequestMaxAgeDays,
        }),
        newMeaningfulCount: shown.events.filter((e) => e.isNew && e.level === "show").length,
      }
    : rankFromThreads(input);
  const r = applyOverrides(ranked, state, now, events, me);

  return {
    key: subject.subjectKey,
    header: buildHeader(subject, threads, events, me),
    rounds,
    lastVisitAt: state.dismissedAt,
    body: subjectBody(subject.raw) ?? null,
    links: buildLinks(subject, events),
    section: r.section,
    reasons: r.reasons,
    score: r.score,
    newMeaningfulCount: r.newMeaningfulCount,
    summaryLine: r.summaryLine,
    hiddenStats: r.hiddenStats,
    sortAt: r.sortAt,
    snoozeUntil: state.snoozeUntil,
    unread: threads.some((t) => isUnreadHere(t, state)) || state.keepUnread,
    ...(input.stack ? { stack: input.stack } : {}),
  };
}

/**
 * On a PR I have never visited, only the newest round is shown as new, so a long-running PR
 * does not show its whole history as unread. Ranking still sees every event as new, so an
 * older mention or review request keeps the PR in Waiting.
 */
function onlyNewestRoundIfUnvisited(
  subject: SubjectRecord,
  state: ItemState,
  events: ViewEvent[],
  rounds: Round[],
): { events: ViewEvent[]; rounds: Round[] } {
  const newest = rounds[0];
  if (subject.kind !== "pr" || state.dismissedAt !== null || rounds.length < 2 || !newest) {
    return { events, rounds };
  }
  const cutoff = newest.startedAt;
  const trimmed = events.map((e) => (e.isNew && isAfter(cutoff, e.at) ? { ...e, isNew: false } : e));
  return { events: trimmed, rounds: buildRounds(trimmed) };
}
