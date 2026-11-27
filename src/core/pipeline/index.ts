import { type Config, repoConfig } from "../config.ts";
import type {
  ItemState,
  ReviewThreadRecord,
  StickyCommentVersion,
  SubjectRecord,
  ThreadRecord,
  TimelineItemRecord,
} from "../types.ts";
import type { PushVerdict } from "../rebase/patch.ts";
import type { StackContext } from "../workstreams.ts";
import { deriveFindings } from "../findings/status.ts";
import { classify, isMe, isRestack } from "./classify.ts";
import { quietActivity } from "./hidden.ts";
import { normalize } from "./normalize.ts";
import { applyOverrides, findingsInScope, openedLine, type Rank, rank } from "./rank.ts";
import { buildRounds } from "./rounds.ts";
import { buildHeader, buildLinks, subjectBody } from "./row.ts";
import { isAfter } from "./time.ts";
import type { Finding, RankReason, Round, Section, SubjectView, ViewEvent } from "./types.ts";

export { isRestack, restackText } from "./classify.ts";
export { hiddenReason } from "./hidden.ts";
export { describe } from "./rank.ts";
export { subjectBody, toInboxRow, toViewRecord } from "./row.ts";
export { typenameLabel } from "./text.ts";

/** Bump when derive output changes so every stored view is recomputed. */
export const PIPELINE_VERSION = 5;

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
  /** Checked head force-pushes, keyed by the push's timeline node id. */
  pushVerdicts?: ReadonlyMap<string, PushVerdict>;
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

/** Matches the subjects the enrich job fetches; the rest never get a timeline. */
function willEnrich({ subject, config }: DeriveInput): boolean {
  if (subject.kind === "other") return false;
  return subject.kind !== "issue" || config.polling.enrichIssues;
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
    summaryLine:
      (newest && threadReasonLine(newest.reason)) || (willEnrich(input) ? "not loaded yet" : openedLine(input.subject)),
    hiddenStats: { pushes: 0, rebases: 0, merged: 0, closed: 0 },
    sortAt,
  };
}

export type SubjectEventsInput = Pick<
  DeriveInput,
  "subject" | "items" | "stickies" | "config" | "me" | "pushVerdicts"
> & {
  dismissedAt: string | null;
};

/** A subject's classified timeline events. */
export function subjectEvents(input: SubjectEventsInput): ViewEvent[] {
  const { subject, config, me } = input;
  return classify(normalize({ repo: subject.repo, items: input.items, stickies: input.stickies }), {
    config,
    me,
    mode: repoConfig(config, subject.repo).mode,
    subjectKind: subject.kind,
    mySubject: isMe(subject.author ?? undefined, me),
    dismissedAt: input.dismissedAt,
    ...(input.pushVerdicts ? { pushVerdicts: input.pushVerdicts } : {}),
  });
}

/**
 * Pure derivation from stored GitHub data and local state to one subject's view. Same input,
 * same output: `now`, `config` and `me` are passed in.
 */
export function deriveSubjectView(input: DeriveInput): SubjectView {
  const { subject, threads, state, config, me, now } = input;
  const events = subjectEvents({ ...input, dismissedAt: state.dismissedAt });
  const allRounds = buildRounds(events);
  const shown = onlyNewestRoundIfUnvisited(subject, state, events, allRounds);
  const rounds = shown.rounds;
  const enriched = subject.timelineSyncedUntil !== null || events.length > 0;
  const findings = findingsInScope(subject, events, me) ? subjectFindings(input, events) : undefined;
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
          ...(findings ? { findings } : {}),
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
    ...(enriched ? { quiet: quietActivity(events) } : {}),
    ...(input.stack ? { stack: input.stack } : {}),
    ...(findings ? { findings } : {}),
  };
}

/** The later of the last visit and the last Done: findings first reported after it are new. */
function findingsSince(state: ItemState): string | null {
  const { dismissedAt, doneAt } = state;
  if (dismissedAt === null || doneAt == null) return dismissedAt ?? doneAt ?? null;
  return isAfter(doneAt, dismissedAt) ? doneAt : dismissedAt;
}

function subjectFindings(input: DeriveInput, events: ViewEvent[]): Finding[] {
  const pushes = events
    .filter((e) => e.kind === "forcePush")
    .map((e) => ({ before: e.data.beforeSha ?? null, after: e.data.afterSha ?? null, restack: isRestack(e) }));
  return deriveFindings({
    headSha: input.subject.headSha,
    stickies: input.stickies,
    reviewThreads: input.reviewThreads,
    pushes,
    since: findingsSince(input.state),
  });
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
