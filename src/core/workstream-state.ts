// User state for workstreams (priority, snooze, name, membership edits, visits), and which
// workstreams get a row.
import { snoozeActive } from "./pipeline/rank.ts";
import type { Section, ViewEvent } from "./pipeline/types.ts";
import { isValidStateOp } from "./state.ts";
import type { ItemState, Login, SubjectKey } from "./types.ts";
import type { Workstream } from "./workstreams.ts";

export type WsPriority = "normal" | "low" | "muted";

export const WS_PRIORITIES: readonly WsPriority[] = ["normal", "low", "muted"];

export interface WorkstreamState {
  priority: WsPriority;
  /** When Mark first opened the workstream; null means it is new to him. */
  seenAt: string | null;
  /** `inputHash` of the summary Mark last saw. */
  seenSummaryHash: string | null;
  snoozeUntil: string | null;
  /** Wake on a human event on any member after `snoozedAt`. */
  snoozeUntilHumanEvent: boolean;
  /** Wake when any member becomes ready. */
  snoozeUntilReady: boolean;
  snoozedAt: string | null;
}

export const DEFAULT_WORKSTREAM_STATE: WorkstreamState = {
  priority: "normal",
  seenAt: null,
  seenSummaryHash: null,
  snoozeUntil: null,
  snoozeUntilHumanEvent: false,
  snoozeUntilReady: false,
  snoozedAt: null,
};

export interface WorkstreamTarget {
  kind: "workstream";
  id: string;
}

/** An op on one workstream. Done all is per-member `done` on the member keys. */
export type WorkstreamOp =
  | { kind: "setPriority"; priority: WsPriority }
  /** At least one of `until`, `untilHumanEvent`, `untilReady` is set. */
  | { kind: "snooze"; until: string | null; untilHumanEvent: boolean; untilReady: boolean }
  | { kind: "unsnooze" }
  /** A null name clears the manual name. */
  | { kind: "rename"; name: string | null }
  /** Workstream `from` joins the target workstream. */
  | { kind: "merge"; from: string }
  /** `key` leaves the target workstream. */
  | { kind: "remove"; key: SubjectKey }
  /** `key`, an open PR in no workstream, joins the target workstream. */
  | { kind: "add"; key: SubjectKey }
  /** Mark opened the workstream; `summaryHash` is the summary he saw, if any. */
  | { kind: "seen"; summaryHash: string | null };

export type WorkstreamOpKind = WorkstreamOp["kind"];

/** Ops that change `workstream_state`; the others edit names and overrides. */
export type WorkstreamStateOp = Extract<WorkstreamOp, { kind: "setPriority" | "snooze" | "unsnooze" | "seen" }>;

export function isWorkstreamStateOp(op: WorkstreamOp): op is WorkstreamStateOp {
  return op.kind === "setPriority" || op.kind === "snooze" || op.kind === "unsnooze" || op.kind === "seen";
}

export function applyWorkstreamOp(state: WorkstreamState, op: WorkstreamStateOp, now: string): WorkstreamState {
  switch (op.kind) {
    case "setPriority":
      // Setting a priority counts as having seen the workstream.
      return { ...state, priority: op.priority, seenAt: state.seenAt ?? now };
    case "snooze":
      return {
        ...state,
        snoozeUntil: op.until,
        snoozeUntilHumanEvent: op.untilHumanEvent,
        snoozeUntilReady: op.untilReady,
        snoozedAt: now,
      };
    case "unsnooze":
      return { ...state, snoozeUntil: null, snoozeUntilHumanEvent: false, snoozeUntilReady: false, snoozedAt: null };
    case "seen":
      return { ...state, seenAt: state.seenAt ?? now, seenSummaryHash: op.summaryHash ?? state.seenSummaryHash };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => k in value);

const MAX_NAME = 200;

/** Checks a request body's workstream `op`. */
export function isValidWorkstreamOp(value: unknown): value is WorkstreamOp {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "setPriority":
      return hasKeys(value, ["kind", "priority"]) && WS_PRIORITIES.includes(value.priority as WsPriority);
    case "snooze":
    case "unsnooze":
      return isValidStateOp(value);
    case "rename":
      return (
        hasKeys(value, ["kind", "name"]) &&
        (value.name === null ||
          (typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= MAX_NAME))
      );
    case "merge":
      return hasKeys(value, ["kind", "from"]) && typeof value.from === "string" && value.from.length > 0;
    case "remove":
    case "add":
      return hasKeys(value, ["kind", "key"]) && typeof value.key === "string" && value.key.length > 0;
    case "seen":
      return (
        hasKeys(value, ["kind", "summaryHash"]) && (value.summaryHash === null || typeof value.summaryHash === "string")
      );
    default:
      return false;
  }
}

export function isValidWorkstreamTarget(value: unknown): value is WorkstreamTarget {
  return (
    isRecord(value) &&
    hasKeys(value, ["kind", "id"]) &&
    value.kind === "workstream" &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

/**
 * Whether a group snooze still holds, given each member's events. It uses the same wake
 * rules as a subject snooze and ends when any member would wake.
 */
export function workstreamSnoozeActive(
  state: WorkstreamState,
  memberEvents: readonly ViewEvent[][],
  me: Login | null,
  now: Date,
): boolean {
  const item: ItemState = {
    dismissedAt: null,
    doneAt: null,
    readAt: null,
    keepUnread: false,
    snoozeUntil: state.snoozeUntil,
    snoozeUntilHumanEvent: state.snoozeUntilHumanEvent,
    snoozeUntilReady: state.snoozeUntilReady,
    snoozedAt: state.snoozedAt,
    muted: false,
  };
  if (memberEvents.length === 0) return snoozeActive(item, [], me, now);
  return memberEvents.every((events) => snoozeActive(item, events, me, now));
}

/**
 * Whether a group snooze can end on member activity (a human event or a member becoming
 * ready), so holding it needs the members' events, not just the time.
 */
export function snoozeWakesOnActivity(state: WorkstreamState): boolean {
  return state.snoozedAt !== null && (state.snoozeUntilHumanEvent || state.snoozeUntilReady);
}

/** What the store knows about one workstream member, for deciding whether Mark is involved. */
export interface MemberFacts {
  /** PR author, from the subject or the open-PR listing. */
  author: Login | null;
  /** Reviewers with an open request (requested and not removed since). */
  requestedReviewers: Login[];
  /** Logins that submitted a review. */
  reviewers: Login[];
  /** Logins that commented. */
  commenters: Login[];
  /** Section of the subject's view when it has a notification thread; null without a thread. */
  threadSection: Section | null;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Mark is involved in a member he authored, was asked to review, reviewed, commented on, or
 * has a notification thread for that is not in Hidden.
 */
export function isInvolved(facts: MemberFacts, me: Login | null): boolean {
  if (facts.threadSection !== null && facts.threadSection !== "hidden") return true;
  if (me === null) return false;
  if (facts.author !== null && sameLogin(facts.author, me)) return true;
  return [...facts.requestedReviewers, ...facts.reviewers, ...facts.commenters].some((l) => sameLogin(l, me));
}

/**
 * A workstream gets a row when Mark is involved in any member, or when he has not seen it yet.
 * `seenAt` is from the workstream's stored state (null or missing state: not seen).
 */
export function isShownWorkstream(
  ws: Pick<Workstream, "members">,
  facts: ReadonlyMap<SubjectKey, MemberFacts>,
  me: Login | null,
  seenAt: string | null,
): boolean {
  if (seenAt === null) return true;
  return ws.members.some((key) => {
    const f = facts.get(key);
    return f !== undefined && isInvolved(f, me);
  });
}

/**
 * Whether the inbox lists a workstream: shown ones, plus muted ones Mark is not involved in,
 * which go to Hidden instead of leaving the list. The worker still uses `isShownWorkstream`, so
 * new members of a muted workstream do not become subjects.
 */
export function isListedWorkstream(
  ws: Pick<Workstream, "members">,
  facts: ReadonlyMap<SubjectKey, MemberFacts>,
  me: Login | null,
  state: Pick<WorkstreamState, "priority" | "seenAt"> | null,
): boolean {
  return state?.priority === "muted" || isShownWorkstream(ws, facts, me, state?.seenAt ?? null);
}
