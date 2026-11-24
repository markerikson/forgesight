import type { ItemState, SubjectRecord, ThreadRecord } from "../types.ts";
import { isHumanText, isMe } from "./classify.ts";
import { firstLine, mentions, truncate } from "./text.ts";
import { isAfter, ms } from "./time.ts";
import type { HiddenStats, RankReason, Round, Section, ViewEvent } from "./types.ts";

export interface RankInput {
  subject: SubjectRecord;
  threads: ThreadRecord[];
  /** Classified events, oldest first. */
  events: ViewEvent[];
  rounds: Round[];
  state: ItemState;
  me: string | null;
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
    case "unknown":
      return act(`updated (${e.data.typename})`);
  }
}

function last<T>(list: T[]): T | undefined {
  return list[list.length - 1];
}

function mentionsMe(e: ViewEvent, me: string | null): boolean {
  if (me === null) return false;
  if (e.kind === "mentioned") return isMe(e.data.target, me);
  return e.body !== undefined && mentions(e.body, me);
}

/** True when a review request for me is open and I have not reviewed since it was made. */
function openReviewRequest(subject: SubjectRecord, events: ViewEvent[], me: string | null): boolean {
  if (me === null || subject.state !== "OPEN") return false;
  const requested = nodes(obj(subject.raw)?.reviewRequests).some((n) =>
    isMe(obj(n.requestedReviewer)?.login as string | undefined, me),
  );
  if (!requested) return false;
  const lastRequest = last(events.filter((e) => e.kind === "reviewRequested" && isMe(e.data.target, me)));
  if (!lastRequest) return true;
  return !events.some((e) => e.kind === "review" && isMe(e.actor?.login, me) && isAfter(e.at, lastRequest.at));
}

function iReviewed(subject: SubjectRecord, events: ViewEvent[], me: string | null): boolean {
  if (me === null) return false;
  if (events.some((e) => e.kind === "review" && isMe(e.actor?.login, me))) return true;
  return nodes(obj(subject.raw)?.latestReviews).some((n) => isMe(obj(n.author)?.login as string | undefined, me));
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
 * Updates: anything else new and shown. Hidden: nothing new and shown, or a PR someone else
 * merged or closed with no new human comment. Snooze and mute are applied by `applyOverrides`.
 */
export function rank(input: RankInput): Rank {
  const { subject, threads, events, rounds, state, me } = input;
  const isPr = subject.kind === "pr";
  const fresh = events.filter((e) => e.isNew);
  const shown = fresh.filter((e) => e.level === "show");
  const human = shown.filter(isHumanText);
  const reasons: RankReason[] = [];
  const add = (r: RankReason) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  if (isPr && openReviewRequest(subject, events, me)) add("reviewRequested");
  if (shown.some((e) => mentionsMe(e, me))) add("mentioned");
  if (!isPr && fresh.some((e) => e.kind === "assigned" && e.data.added !== false && isMe(e.data.target, me))) {
    add("assigned");
  }
  if (human.length > 0) {
    if (isMe(subject.author ?? undefined, me)) add("onMyPr");
    if (isPr && iReviewed(subject, events, me)) add("onMyReview");
    if (!isPr && assignedToMe(subject, me)) add("assigned");
    if (threads.some((t) => PARTICIPATING_REASONS.has(t.reason))) add("participating");
  }
  let section: Section = reasons.length > 0 ? "waiting" : "updates";

  const closedByOthers =
    (subject.state === "MERGED" || subject.state === "CLOSED") && !isMe(subject.author ?? undefined, me);
  if (section === "updates") {
    if (isPr && closedByOthers && human.length === 0) {
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

  const newest = last(shown);
  const lastRequest = last(events.filter((e) => e.kind === "reviewRequested" && isMe(e.data.target, me)));
  let summaryLine = "";
  if (newest) summaryLine = describe(newest);
  else if (reasons.includes("reviewRequested")) {
    summaryLine = lastRequest ? describe(lastRequest) : "review requested";
  } else {
    const fallback = last(events.filter((e) => e.level !== "hidden" && e.kind !== "unknown")) ?? last(events);
    if (fallback) summaryLine = describe(fallback);
  }

  const sortAt =
    newest?.at ??
    lastRequest?.at ??
    last(fresh)?.at ??
    last(events)?.at ??
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
 * Local state that overrides any rank: mute hides the subject unless I am asked for review
 * or mentioned, and an active snooze moves it to Snoozed.
 */
export function applyOverrides(r: Rank, state: ItemState, now: Date): Rank {
  let { section, reasons } = r;
  if (state.muted && !reasons.includes("reviewRequested") && !reasons.includes("mentioned")) {
    section = "hidden";
    if (!reasons.includes("muted")) reasons = [...reasons, "muted"];
  }
  if (state.snoozeUntil !== null && isAfter(state.snoozeUntil, now.toISOString())) {
    section = "snoozed";
    if (!reasons.includes("snoozed")) reasons = ["snoozed", ...reasons];
  }
  return { ...r, section, reasons };
}
