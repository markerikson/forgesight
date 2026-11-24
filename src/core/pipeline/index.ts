import { type Config, repoConfig } from "../config.ts";
import type {
  ItemState,
  ReviewThreadRecord,
  StickyCommentVersion,
  SubjectRecord,
  ThreadRecord,
  TimelineItemRecord,
} from "../types.ts";
import { classify, isMe } from "./classify.ts";
import { normalize } from "./normalize.ts";
import { applyOverrides, type Rank, rank } from "./rank.ts";
import { buildRounds } from "./rounds.ts";
import { buildHeader, buildLinks } from "./row.ts";
import { isAfter } from "./time.ts";
import type { RankReason, Section, SubjectView } from "./types.ts";

export { describe } from "./rank.ts";
export { toInboxRow, toViewRecord } from "./row.ts";

/** Bump when derive output changes so every stored view is recomputed. */
export const PIPELINE_VERSION = 2;

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
}

const THREAD_WAITING: Record<string, RankReason> = {
  review_requested: "reviewRequested",
  mention: "mentioned",
  team_mention: "mentioned",
  assign: "assigned",
};

/**
 * Rank for a subject enrichment has not reached yet: only the notification threads are
 * known, so an unread thread newer than the last visit counts as an update.
 */
function rankFromThreads(input: DeriveInput): Rank {
  const { threads, state } = input;
  const fresh = threads.filter(
    (t) => t.unread && (state.dismissedAt === null || isAfter(t.updatedAt, state.dismissedAt)),
  );
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
    summaryLine: newest ? `notification: ${newest.reason.replaceAll("_", " ")}` : "",
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
  const rounds = buildRounds(events);
  const enriched = subject.timelineSyncedUntil !== null || events.length > 0;
  const r = applyOverrides(
    enriched ? rank({ subject, threads, events, rounds, state, me }) : rankFromThreads(input),
    state,
    now,
  );

  return {
    key: subject.subjectKey,
    header: buildHeader(subject, threads, events, me),
    rounds,
    lastVisitAt: state.dismissedAt,
    links: buildLinks(subject, events),
    section: r.section,
    reasons: r.reasons,
    score: r.score,
    newMeaningfulCount: r.newMeaningfulCount,
    summaryLine: r.summaryLine,
    hiddenStats: r.hiddenStats,
    sortAt: r.sortAt,
    snoozeUntil: state.snoozeUntil,
    unread: threads.some((t) => t.unread),
  };
}
