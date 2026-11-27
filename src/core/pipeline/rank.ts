import type { Finding } from "../findings/types.ts";
import type { ItemState, SubjectRecord, ThreadRecord } from "../types.ts";
import { isHumanText, isMe, isRestack, restackText } from "./classify.ts";
import { CLOSING_RELATIONS, linkName } from "../links.ts";
import { closeText, firstLine, mentions, truncate, typenameLabel } from "./text.ts";
import { isAfter, ms } from "./time.ts";
import type { EventKind, HiddenStats, LinkedSubject, RankReason, Round, Section, ViewEvent } from "./types.ts";

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
  /** Review-bot findings, set only for PRs in findings scope. */
  findings?: readonly Finding[];
  /** Linked PRs and issues, strongest first, from `linksFor`. */
  linked?: readonly LinkedSubject[];
  /** Where new human comments go on an issue I only get notifications for. Defaults to hidden. */
  subscribedIssueComments?: "updates" | "hidden";
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

/** One-line description of an event for the inbox row. `repo` is the subject's, to shorten same-repo references. */
export function describe(e: ViewEvent, repo?: string): string {
  const act = (verb: string) => (e.actor ? `${e.actor.login} ${verb}` : verb);
  const text = e.body ? firstLine(e.body) : "";
  const withText = (verb: string) => truncate(text ? `${act(verb)}: ${text}` : act(verb));
  switch (e.kind) {
    case "comment":
      return withText(e.data.replyTo ? "replied" : "commented");
    case "review":
      return withText(REVIEW_VERBS[e.data.reviewState ?? ""] ?? "reviewed");
    case "reviewComment":
      return withText("commented on the diff");
    case "merged":
      return act("merged");
    case "closed":
      return act(closeText(e.data.stateReason));
    case "closedByPr":
      return e.data.ref ? `fixed by ${linkName(e.data.ref, repo ?? e.data.ref.repo)}` : act("closed");
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
      if (e.actor && e.data.target && e.actor.login.toLowerCase() === e.data.target.toLowerCase()) {
        return act(e.data.added === false ? "unassigned themselves" : "self-assigned");
      }
      return act(`${e.data.added === false ? "unassigned" : "assigned"} ${e.data.target ?? "someone"}`);
    case "commit":
      return truncate(`${act("pushed")}: ${e.data.headline ?? e.data.sha?.slice(0, 10) ?? "a commit"}`);
    case "forcePush":
      return act(isRestack(e) ? restackText(e) : "force-pushed");
    case "baseForcePush":
      return act("force-pushed the base branch");
    case "baseChanged":
      if (e.actor === null) return truncate(`base changed automatically to ${e.data.to ?? "another branch"} (old base ${e.data.from ?? "gone"})`);
      return truncate(act(`changed the base to ${e.data.to ?? "another branch"}`));
    case "crossReference":
    case "connected":
      return truncate(act(e.data.ref ? `referenced this in ${e.data.ref.repo}#${e.data.ref.number}` : "referenced this"));
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
    case "answered":
      return act("marked an answer");
    case "unknown":
      return act(typenameLabel(e.data.typename));
  }
}

/** Kinds whose description says too little to stand alone as a row's summary. */
const WEAK_SUMMARY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["labeled", "unknown", "mentioned", "milestoned"]);

/** Summary for a subject with no event worth describing. */
export function openedLine(subject: SubjectRecord): string {
  if (subject.kind === "other") return "no details loaded";
  const noun = subject.kind === "pr" ? "PR" : subject.kind;
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

/** PRs whose review-bot findings matter to me: mine, ones I reviewed, and ones I am asked to review. */
export function findingsInScope(subject: SubjectRecord, events: ViewEvent[], me: string | null): boolean {
  if (subject.kind !== "pr" || me === null) return false;
  if (isMe(subject.author ?? undefined, me) || iReviewed(subject, events, me)) return true;
  return nodes(obj(subject.raw)?.reviewRequests).some((n) =>
    isMe(obj(n.requestedReviewer)?.login as string | undefined, me),
  );
}

function newSeriousFindings(findings: readonly Finding[] | undefined): Finding[] {
  return (findings ?? []).filter((f) => f.isNew && f.serious && f.status === "outstanding");
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

/**
 * A discussion post has no timeline event, so a mention in it shows up only in the body. It counts
 * when the post was written or edited after I last dismissed the discussion.
 */
function postMentionsMe(subject: SubjectRecord, dismissedAt: string | null, me: string | null): boolean {
  const raw = obj(subject.raw);
  if (me === null || typeof raw?.body !== "string" || !mentions(raw.body, me)) return false;
  if (dismissedAt === null) return true;
  return [raw.createdAt, raw.lastEditedAt].some((at) => typeof at === "string" && isAfter(at, dismissedAt));
}

function hiddenStats(events: ViewEvent[], rounds: Round[]): HiddenStats {
  return {
    pushes: rounds
      .filter((r) => r.startedBy !== null && r.startedBy.isNew)
      .reduce((sum, r) => sum + r.pushCount, 0),
    rebases: events.filter((e) => e.isNew && isRestack(e)).length,
    merged: events.some((e) => e.isNew && e.kind === "merged") ? 1 : 0,
    closed: events.some((e) => e.isNew && (e.kind === "closed" || e.kind === "closedByPr")) &&
      !events.some((e) => e.isNew && e.kind === "merged")
      ? 1
      : 0,
  };
}

const TOOL_NAMES: Record<Finding["tool"], string> = { diffloupe: "DiffLoupe", coderabbit: "CodeRabbit" };

function findingsLine(findings: readonly Finding[]): string {
  const [first] = findings;
  if (!first) return "";
  const lead = `${TOOL_NAMES[first.tool]} found: ${first.title}`;
  return truncate(findings.length > 1 ? `${lead} (+${findings.length - 1} more)` : lead);
}

const STATE_KINDS = new Set(["merged", "closed", "closedByPr", "reopened", "answered"]);

/** Announcement discussions are release notes and news; activity on them only matters when it involves me. */
function isAnnouncement(subject: SubjectRecord): boolean {
  const name = obj(obj(subject.raw)?.category)?.name;
  return typeof name === "string" && name.toLowerCase() === "announcements";
}

const TOOK_PART_THREAD_REASONS = new Set([...PARTICIPATING_REASONS, "comment", "state_change", "manual"]);

/** I wrote, commented, changed state, was assigned, or subscribed by hand. */
function tookPartIn(subject: SubjectRecord, threads: ThreadRecord[], events: ViewEvent[], me: string | null): boolean {
  if (threads.some((t) => TOOK_PART_THREAD_REASONS.has(t.reason))) return true;
  if (subject.kind === "issue" && assignedToMe(subject, me)) return true;
  return events.some((e) => BODY_KINDS.has(e.kind) && isMe(e.actor?.login, me));
}

/** The PR that fixes an issue: a merged closing PR first, else an open one. */
function closingPr(linked: readonly LinkedSubject[] | undefined): LinkedSubject | undefined {
  const closing = (linked ?? []).filter((l) => l.kind === "pr" && CLOSING_RELATIONS.has(l.relation));
  return closing.find((l) => l.state === "MERGED") ?? closing.find((l) => l.state !== "CLOSED");
}

/** An issue closed as not planned or as a duplicate, by someone other than me. */
function closedUnplanned(subject: SubjectRecord, events: ViewEvent[], me: string | null): boolean {
  if (subject.state !== "CLOSED") return false;
  const close = last(events.filter((e) => e.kind === "closed" || e.kind === "closedByPr"));
  if (close && isMe(close.actor?.login, me)) return false;
  const reason = close ? close.data.stateReason : obj(subject.raw)?.stateReason;
  return reason === "NOT_PLANNED" || reason === "DUPLICATE";
}

/**
 * Picks the inbox section. Waiting: an open review request for me, a new mention of me, or
 * new human comments on something I authored, reviewed, was assigned or am participating in,
 * any open PR of mine (drafts too) that I have not marked done since its last shown event,
 * or a new blocker or should-fix review-bot finding on an open PR I reviewed or was asked to review.
 * Once something I authored is closed, only a new mention or review request makes it waiting.
 * Updates: anything else new and shown. Hidden: nothing new and shown, a PR someone else
 * merged or closed with no new human comment, or a PR its author closed unmerged that I never
 * reviewed or commented on (counted per repo instead). For issues someone else opened, Hidden
 * also takes a close with no new human comment and no linked fixing PR, a close as not planned
 * or duplicate when I took no part, and new human comments on an issue I only get notifications
 * for, unless the repo sends those to Updates. Keep-unread, snooze and mute are applied by
 * `applyOverrides`.
 */
export function rank(input: RankInput): Rank {
  const { subject, threads, events, rounds, state, me, now } = input;
  const isPr = subject.kind === "pr";
  const isDiscussion = subject.kind === "discussion";
  const isIssue = subject.kind === "issue";
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
  if (isDiscussion && postMentionsMe(subject, state.dismissedAt, me)) add("mentioned");
  if (!isPr && fresh.some((e) => e.kind === "assigned" && e.data.added !== false && isMe(e.data.target, me))) {
    add("assigned");
  }
  const mine = isMe(subject.author ?? undefined, me);
  if (human.length > 0) {
    if (mine) add("onMine");
    if (isPr && iReviewed(subject, events, me)) add("onMyReview");
    if (!isPr && assignedToMe(subject, me)) add("assigned");
    if (threads.some((t) => PARTICIPATING_REASONS.has(t.reason))) add("participating");
    if (isDiscussion && events.some((e) => e.kind === "comment" && isMe(e.actor?.login, me))) add("participating");
  }
  if (isDiscussion && mine && shown.some((e) => e.kind === "answered")) add("onMine");
  const closed = subject.state === "MERGED" || subject.state === "CLOSED";
  // My open PRs, drafts included, are my work queue. Done still clears one until something new shows.
  if (isPr && mine && subject.state === "OPEN" && (state.doneAt == null || shown.length > 0)) add("myOpenPr");
  // My own open PRs already wait; on others, a new blocker or should-fix finding raises it.
  const newFindings = isPr && !mine && subject.state === "OPEN" ? newSeriousFindings(input.findings) : [];
  if (newFindings.length > 0) add("newFindings");
  // Once my own PR or issue is closed, only a new mention or review request keeps it waiting.
  const waits = closed && mine
    ? reasons.some((r) => r === "mentioned" || r === "reviewRequested")
    : reasons.some((r) => r !== "staleReviewRequest");
  let section: Section = waits ? "waiting" : "updates";

  const closedByOthers = closed && !mine;
  const fixedBy = isIssue ? closingPr(input.linked) : undefined;
  const tookPart = mine || tookPartIn(subject, threads, events, me);
  const stateChanged = shown.some((e) => STATE_KINDS.has(e.kind));
  if (section === "updates") {
    if (isClosedByAuthor(subject, events, me)) {
      section = "hidden";
      add("closedByAuthor");
    } else if (closedByOthers && human.length === 0 && (isPr || (isIssue && fixedBy === undefined && shown.length > 0))) {
      section = "hidden";
      add("closedByOthers");
    } else if (isDiscussion && isAnnouncement(subject)) {
      section = "hidden";
      add("announcement");
    } else if (isIssue && closedByOthers && !tookPart && closedUnplanned(subject, events, me)) {
      section = "hidden";
      add("closedByOthers");
    } else if (
      isIssue && !tookPart && human.length > 0 && !stateChanged && input.subscribedIssueComments !== "updates"
    ) {
      if (isNewIssue(subject, state.dismissedAt, me)) {
        add("newIssue");
      } else {
        section = "hidden";
        add("subscribedOnly");
      }    } else if (shown.length > 0) {
      add(shown.some((e) => STATE_KINDS.has(e.kind)) ? "stateChange" : "newActivity");
    } else if (!isPr && isNewIssue(subject, state.dismissedAt, me) && events.every((e) => e.kind !== "comment")) {
      add(isDiscussion ? "newDiscussion" : "newIssue");
    } else {
      section = "hidden";
      add("nothingNew");
    }
  }

  // A new label or milestone alone says little; a stronger new event, or the opening, says more.
  // "you were mentioned" stays, since nothing else explains why a mention made it wait.
  const summarized = last(shown.filter((e) => !WEAK_SUMMARY_KINDS.has(e.kind))) ??
    (newest?.kind === "mentioned" ? newest : undefined);
  // An issue closed by a merge reads "fixed by #N" rather than "closed".
  const fixedLine = fixedBy
    ? fixedBy.state === "MERGED"
      ? `fixed by ${linkName(fixedBy, subject.repo)}`
      : `linked to ${linkName(fixedBy, subject.repo)} (open)`
    : undefined;
  const closeIsFix = summarized?.kind === "closed" && fixedBy?.state === "MERGED" &&
    summarized.data.stateReason !== "NOT_PLANNED";
  let summaryLine = "";
  if (summarized) summaryLine = closeIsFix && fixedLine ? fixedLine : describe(summarized, subject.repo);
  else if (newFindings.length > 0) summaryLine = findingsLine(newFindings);
  else if (reasons.includes("reviewRequested") || reasons.includes("staleReviewRequest")) {
    summaryLine = lastRequest ? describe(lastRequest, subject.repo) : "review requested";
  } else if (fixedLine) {
    summaryLine = fixedLine;
  } else {
    const dated = events.filter((e) => e.undated !== true && !WEAK_SUMMARY_KINDS.has(e.kind));
    const fallback = last(dated.filter((e) => e.level !== "hidden")) ?? last(dated);
    summaryLine = fallback ? describe(fallback, subject.repo) : openedLine(subject);
  }

  const sortAt =
    newest?.at ??
    newFindings.map((f) => f.firstSeenAt).sort().at(-1) ??
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
