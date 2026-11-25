import type { ItemState, SubjectRecord, ThreadRecord } from "../types.ts";
import { isHumanText, isMe } from "./classify.ts";
import { firstLine, mentions, truncate, typenameLabel } from "./text.ts";
import { isAfter, ms } from "./time.ts";
import type { EventKind, HiddenStats, RankReason, Round, Section, ViewEvent } from "./types.ts";

export interface RankInput {
  subject: SubjectRecord;
  threads: ThreadRecord[];
  /** Classified events, oldest first. */
  events: ViewEvent[];
  rounds: Round[];
  state: ItemState;
  me: string | null;
  now: Date;
  /** A review request older than this, with nothing shown since, no longer counts as waiting. */
  reviewRequestMaxAgeDays: number;
}

export interface Rank {
  section: Section;
  reasons: RankReason[];
  score: number;
  newMeaningfulCount: number;
  summaryLine: string;
  hiddenStats: HiddenStats;
  sortAt: string;
}

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
}

function nodes(value: unknown): Raw[] {
  const list = obj(value)?.nodes;
  return Array.isArray(list) ? list.map(obj).filter((n) => n !== null) : [];
}

const PARTICIPATING_REASONS = new Set(["mention", "team_mention", "review_requested", "author", "assign"]);

const REVIEW_VERBS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  DISMISSED: "reviewed",
};

/** One-line description of an event for the inbox row. */
export function describe(e: ViewEvent): string {
  const act = (verb: string) => (e.actor ? `${e.actor.login} ${verb}` : verb);
  const text = e.body ? firstLine(e.body) : "";
  const withText = (verb: string) => truncate(text ? `${act(verb)}: ${text}` : act(verb));
  switch (e.kind) {
    case "comment":
      return withText("commented");
    case "review":
      return withText(REVIEW_VERBS[e.data.reviewState ?? ""] ?? "reviewed");
    case "reviewComment":
      return withText("commented on the diff");
    case "merged":
      return act("merged");
    case "closed":
      return act("closed");
    case "closedByPr":
      return e.data.ref ? `closed by #${e.data.ref.number}` : act("closed");
    case "reopened":
      return act("reopened");
    case "readyForReview":
      return act("marked ready for review");
    case "convertToDraft":
      return act("converted to draft");
    case "reviewRequested":
      return act(`requested review from ${e.data.target ?? "someone"}`);
    case "reviewRequestRemoved":
      return act(`removed review request for ${e.data.target ?? "someone"}`);
    case "reviewDismissed":
      return act("dismissed a review");
    case "mentioned":
      return "you were mentioned";
    case "assigned":
      return act(`${e.data.added === false ? "unassigned" : "assigned"} ${e.data.target ?? "someone"}`);
    case "commit":
      return truncate(`${act("pushed")}: ${e.data.headline ?? e.data.sha?.slice(0, 10) ?? "a commit"}`);
    case "forcePush":
      return act("force-pushed");
    case "baseForcePush":
      return act("force-pushed the base branch");
    case "baseChanged":
      if (e.actor === null) return truncate(`base changed automatically to ${e.data.to ?? "another branch"} (old base ${e.data.from ?? "gone"})`);
      return truncate(act(`changed the base to ${e.data.to ?? "another branch"}`));
    case "crossReference":
    case "connected":
      return e.data.ref ? truncate(`referenced in ${e.data.ref.repo}#${e.data.ref.number}`) : act("referenced this");
    case "reference":
      return act("referenced this in a commit");
    case "markedDuplicate":
      return act("marked as duplicate");
    case "renamed":
      return truncate(act(`renamed to ${e.data.to ?? ""}`));
    case "labeled":
      return act(`${e.data.added === false ? "removed" : "added"} label ${e.data.label ?? ""}`.trim());
    case "stack":
      return act("changed the stack");
    case "transferred":
      return act("transferred this");
    case "subIssue":
      return act("changed sub-issues");
    case "milestoned":
      if (e.data.added === false) return act("removed the milestone");
      return truncate(act(e.data.milestone ? `added to milestone ${e.data.milestone}` : "set the milestone"));
    case "unknown":
      return act(typenameLabel(e.data.typename));
  }
}

/** Kinds whose description says too little to stand alone as a row's summary. */
const WEAK_SUMMARY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["labeled", "unknown", "mentioned", "milestoned"]);

/** Summary for a subject with no event worth describing. */
function openedLine(subject: SubjectRecord): string {
  const noun = subject.kind === "pr" ? "PR" : "issue";
  return subject.author ? `${subject.author} opened this ${noun}` : `${noun} with no loaded activity`;
}

function last<T>(list: T[]): T | undefined {
  return list[list.length - 1];
}

function mentionsMe(e: ViewEvent, me: string | null): boolean {
  if (me === null) return false;
  if (e.kind === "mentioned") return isMe(e.data.target, me);
  return e.body !== undefined && mentions(e.body, me);
}

/**
 * True when a review request for me is open, was made after my last Done, and I have not
 * reviewed since it was made. Reading the subject does not clear it.
 */
function openReviewRequest(
  subject: SubjectRecord,
  events: ViewEvent[],
  me: string | null,
  doneAt: string | null,
): boolean {
  if (me === null || subject.state !== "OPEN") return false;
  const requested = nodes(obj(subject.raw)?.reviewRequests).some((n) =>
    isMe(obj(n.requestedReviewer)?.login as string | undefined, me),
  );
  if (!requested) return false;
  const lastRequest = last(events.filter((e) => e.kind === "reviewRequested" && isMe(e.data.target, me)));
  if (!lastRequest) return doneAt === null;
  if (doneAt !== null && !isAfter(lastRequest.at, doneAt)) return false;
  return !events.some((e) => e.kind === "review" && isMe(e.actor?.login, me) && isAfter(e.at, lastRequest.at));
}

function iReviewed(subject: SubjectRecord, events: ViewEvent[], me: string | null): boolean {
  if (me === null) return false;
  if (events.some((e) => e.kind === "review" && isMe(e.actor?.login, me))) return true;
  return nodes(obj(subject.raw)?.latestReviews).some((n) => isMe(obj(n.author)?.login as string | undefined, me));
}

const BODY_KINDS = new Set(["comment", "review", "reviewComment"]);

/** A PR its author closed without merging, where the close is new and I never reviewed or commented. */
function isClosedByAuthor(subject: SubjectRecord, events: ViewEvent[], me: string | null): boolean {
  if (subject.kind !== "pr" || subject.state !== "CLOSED" || subject.author === null) return false;
  if (isMe(subject.author, me)) return false;
  const close = last(events.filter((e) => e.kind === "closed"));
  if (!close?.isNew || close.actor?.login !== subject.author) return false;
  if (iReviewed(subject, events, me)) return false;
  return !events.some((e) => BODY_KINDS.has(e.kind) && isMe(e.actor?.login, me));
}

function assignedToMe(subject: SubjectRecord, me: string | null): boolean {
  return nodes(obj(subject.raw)?.assignees).some((n) => isMe(n.login as string | undefined, me));
}

/** An issue someone else opened after I last dismissed it (or that I never dismissed). */
function isNewIssue(subject: SubjectRecord, dismissedAt: string | null, me: string | null): boolean {
  if (isMe(subject.author ?? undefined, me)) return false;
  const createdAt = obj(subject.raw)?.createdAt;
  if (typeof createdAt !== "string") return false;
  return dismissedAt === null || isAfter(createdAt, dismissedAt);
}

function hiddenStats(events: ViewEvent[], rounds: Round[]): HiddenStats {
  return {
    pushes: rounds
      .filter((r) => r.startedBy !== null && r.startedBy.isNew)
      .reduce((sum, r) => sum + r.pushCount, 0),
    merged: events.some((e) => e.isNew && e.kind === "merged") ? 1 : 0,
    closed: events.some((e) => e.isNew && (e.kind === "closed" || e.kind === "closedByPr")) &&
      !events.some((e) => e.isNew && e.kind === "merged")
      ? 1
      : 0,
  };
}

const STATE_KINDS = new Set(["merged", "closed", "closedByPr", "reopened"]);

/**
 * Picks the inbox section. Waiting: an open review request for me, a new mention of me, or
 * new human comments on something I authored, reviewed, was assigned or am participating in.
 * Once something I authored is closed, only a new mention or review request makes it waiting.
 * Updates: anything else new and shown. Hidden: nothing new and shown, a PR someone else
 * merged or closed with no new human comment, or a PR its author closed unmerged that I never
 * reviewed or commented on (counted per repo instead). Keep-unread, snooze and mute are
 * applied by `applyOverrides`.
 */
export function rank(input: RankInput): Rank {
  const { subject, threads, events, rounds, state, me, now } = input;
  const isPr = subject.kind === "pr";
  const fresh = events.filter((e) => e.isNew);
  const shown = fresh.filter((e) => e.level === "show");
  const human = shown.filter(isHumanText);
  const reasons: RankReason[] = [];
  const add = (r: RankReason) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  const newest = last(shown);
  const lastRequest = last(events.filter((e) => e.kind === "reviewRequested" && isMe(e.data.target, me)));
  const cutoff = new Date(now.getTime() - input.reviewRequestMaxAgeDays * 86_400_000).toISOString();
  const staleRequest =
    lastRequest !== undefined && !isAfter(lastRequest.at, cutoff) && (!newest || !isAfter(newest.at, cutoff));
  if (isPr && openReviewRequest(subject, events, me, state.doneAt ?? null)) {
    add(staleRequest ? "staleReviewRequest" : "reviewRequested");
  }
  if (shown.some((e) => mentionsMe(e, me))) add("mentioned");
  if (!isPr && fresh.some((e) => e.kind === "assigned" && e.data.added !== false && isMe(e.data.target, me))) {
    add("assigned");
  }
  const mine = isMe(subject.author ?? undefined, me);
  if (human.length > 0) {
    if (mine) add("onMine");
    if (isPr && iReviewed(subject, events, me)) add("onMyReview");
    if (!isPr && assignedToMe(subject, me)) add("assigned");
    if (threads.some((t) => PARTICIPATING_REASONS.has(t.reason))) add("participating");
  }
  const closed = subject.state === "MERGED" || subject.state === "CLOSED";
  // Once my own PR or issue is closed, only a new mention or review request keeps it waiting.
  const waits = closed && mine
    ? reasons.some((r) => r === "mentioned" || r === "reviewRequested")
    : reasons.some((r) => r !== "staleReviewRequest");
  let section: Section = waits ? "waiting" : "updates";

  const closedByOthers = closed && !mine;
  if (section === "updates") {
    if (isClosedByAuthor(subject, events, me)) {
      section = "hidden";
      add("closedByAuthor");
    } else if (isPr && closedByOthers && human.length === 0) {
      section = "hidden";
      add("closedByOthers");
    } else if (shown.length > 0) {
      add(shown.some((e) => STATE_KINDS.has(e.kind)) ? "stateChange" : "newActivity");
    } else if (!isPr && isNewIssue(subject, state.dismissedAt, me) && events.every((e) => e.kind !== "comment")) {
      add("newIssue");
    } else {
      section = "hidden";
      add("nothingNew");
    }
  }

  let summaryLine = "";
  if (newest) summaryLine = describe(newest);
  else if (reasons.includes("reviewRequested") || reasons.includes("staleReviewRequest")) {
    summaryLine = lastRequest ? describe(lastRequest) : "review requested";
  } else {
    const dated = events.filter((e) => e.undated !== true && !WEAK_SUMMARY_KINDS.has(e.kind));
    const fallback = last(dated.filter((e) => e.level !== "hidden")) ?? last(dated);
    summaryLine = fallback ? describe(fallback) : openedLine(subject);
  }

  const sortAt =
    newest?.at ??
    lastRequest?.at ??
    last(fresh)?.at ??
    last(events.filter((e) => e.undated !== true))?.at ??
    subject.updatedAt ??
    last(threads.map((t) => t.updatedAt).sort()) ??
    "1970-01-01T00:00:00Z";

  return {
    section,
    reasons,
    score: newest ? ms(newest.at) : 0,
    newMeaningfulCount: shown.length,
    summaryLine,
    hiddenStats: hiddenStats(events, rounds),
    sortAt,
  };
}

/**
 * True while a snooze holds. It ends at the first of: its time passing, a human comment or
 * review by someone else after it started (when snoozed until a human event), or the PR being
 * marked ready for review after it started (when snoozed until ready). Bot comments and my own
 * never wake it. A snooze without a time has no time limit.
 */
export function snoozeActive(state: ItemState, events: ViewEvent[], me: string | null, now: Date): boolean {
  const untilReady = state.snoozeUntilReady === true;
  if (state.snoozeUntil === null && !state.snoozeUntilHumanEvent && !untilReady) return false;
  if (state.snoozeUntil !== null && !isAfter(state.snoozeUntil, now.toISOString())) return false;
  const since = state.snoozedAt ?? state.dismissedAt;
  const after = events.filter((e) => e.undated !== true && (since === null || isAfter(e.at, since)));
  if (state.snoozeUntilHumanEvent && after.some((e) => isHumanText(e) && !isMe(e.actor?.login, me))) return false;
  if (untilReady && after.some((e) => e.kind === "readyForReview")) return false;
  return true;
}

/**
 * Local state that overrides any rank: keep-unread lifts a hidden subject into Updates, mute
 * hides the subject unless I am asked for review or mentioned, and an active snooze moves it
 * to Snoozed.
 */
export function applyOverrides(
  r: Rank,
  state: ItemState,
  now: Date,
  events: ViewEvent[],
  me: string | null,
): Rank {
  let { section, reasons } = r;
  if (state.keepUnread && section === "hidden") {
    section = "updates";
    reasons = [...reasons, "keptUnread"];
  }
  if (state.muted) {
    if (!reasons.includes("reviewRequested") && !reasons.includes("mentioned")) section = "hidden";
    if (!reasons.includes("muted")) reasons = [...reasons, "muted"];
  }
  if (snoozeActive(state, events, me, now)) {
    section = "snoozed";
    if (!reasons.includes("snoozed")) reasons = ["snoozed", ...reasons];
  }
  return { ...r, section, reasons };
}
