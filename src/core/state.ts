// User state operations (Done, read, snooze, mute ...). The server applies them to stored
// item state; the client applies `patchInbox` to its cached inbox as an optimistic update.
import { compareRows, type InboxPayload, repoCounts, sectionCounts } from "./inbox.ts";
import type { InboxRow } from "./pipeline/types.ts";
import type { ItemState, SubjectKey } from "./types.ts";

export type StateOp =
  | { kind: "done" }
  | { kind: "read" }
  | { kind: "unread" }
  /** At least one of `until`, `untilHumanEvent`, `untilReady` is set. */
  | { kind: "snooze"; until: string | null; untilHumanEvent: boolean; untilReady: boolean }
  | { kind: "unsnooze" }
  | { kind: "mute" }
  | { kind: "unmute" }
  | { kind: "unsubscribe" };

export type StateOpKind = StateOp["kind"];

/** A GitHub write queued in the outbox. */
export type OutboxOp = "done" | "read" | "unsubscribe" | "resubscribe";

export const OUTBOX_OPS: readonly OutboxOp[] = ["done", "read", "unsubscribe", "resubscribe"];

/** What `outboxThreads` needs to know about a subject's notification thread. */
export interface OutboxThread {
  threadId: string;
  /** Unread on GitHub. */
  unread: boolean;
  ghDoneAt: string | null;
  /** The thread's newest unsubscribe/resubscribe outbox row is an unsubscribe that did not fail. */
  unsubscribed: boolean;
}

export interface ApplyStateOpOptions {
  /**
   * For `unread`: `dismissedAt` from before the newest `read` op on the item. Leave it
   * undefined when there was no such op; `dismissedAt` then stays as is.
   */
  dismissedBeforeRead?: string | null | undefined;
}

const NO_SNOOZE = {
  snoozeUntil: null,
  snoozeUntilHumanEvent: false,
  snoozeUntilReady: false,
  snoozedAt: null,
} as const satisfies Partial<ItemState>;

export function applyStateOp(
  state: ItemState,
  op: StateOp,
  now: string,
  opts: ApplyStateOpOptions = {},
): ItemState {
  switch (op.kind) {
    case "done":
      return { ...state, ...NO_SNOOZE, dismissedAt: now, doneAt: now, keepUnread: false };
    case "read":
      return { ...state, dismissedAt: now, keepUnread: false };
    case "unread":
      return {
        ...state,
        keepUnread: true,
        dismissedAt: opts.dismissedBeforeRead === undefined ? state.dismissedAt : opts.dismissedBeforeRead,
      };
    case "snooze":
      return {
        ...state,
        snoozeUntil: op.until,
        snoozeUntilHumanEvent: op.untilHumanEvent,
        snoozeUntilReady: op.untilReady,
        snoozedAt: now,
      };
    case "unsnooze":
      return { ...state, ...NO_SNOOZE };
    case "mute":
    case "unsubscribe":
      return { ...state, muted: true };
    case "unmute":
      return { ...state, muted: false };
  }
}

/**
 * The GitHub write an op queues, given the item's state before the op. Which threads get
 * a row is decided by `outboxThreads`.
 */
export function outboxOpFor(op: StateOp, state: ItemState): OutboxOp | null {
  switch (op.kind) {
    case "done":
      return "done";
    case "read":
      return "read";
    case "unsubscribe":
      return "unsubscribe";
    case "unmute":
      return state.muted ? "resubscribe" : null;
    default:
      return null;
  }
}

/** Ids of the threads that get an outbox row for `op`. */
export function outboxThreads(op: OutboxOp, threads: readonly OutboxThread[]): string[] {
  const wanted = threads.filter((t) => {
    switch (op) {
      case "done":
        return t.ghDoneAt === null;
      case "read":
        return t.unread;
      case "unsubscribe":
        return true;
      case "resubscribe":
        return t.unsubscribed;
    }
  });
  return wanted.map((t) => t.threadId);
}

function keepsSection(row: InboxRow): boolean {
  return row.reasons.includes("reviewRequested") || row.reasons.includes("mentioned");
}

/**
 * The optimistic version of a list row after `op`, or null when the row leaves the list.
 * A row that moves to Hidden is returned with section `hidden` when `includeHidden` is set.
 */
export function patchRow(
  row: InboxRow,
  op: StateOp,
  _now: string,
  opts: { includeHidden?: boolean } = {},
): InboxRow | null {
  const toHidden = (): InboxRow | null => (opts.includeHidden ? { ...row, section: "hidden" } : null);
  switch (op.kind) {
    case "done":
      return toHidden();
    case "mute":
    case "unsubscribe":
      return keepsSection(row) ? { ...row } : toHidden();
    case "snooze":
      return { ...row, section: "snoozed", snoozeUntil: op.until };
    case "read":
      return { ...row, unread: false, newMeaningfulCount: 0 };
    case "unread":
      return { ...row, unread: true };
    case "unsnooze":
    case "unmute":
      return { ...row };
  }
}

/**
 * Applies `patchRow` to the rows with `keys`, re-sorts, and recomputes the sidebar counts.
 * `includeHidden` defaults to whether the payload already lists any Hidden row. Without
 * Hidden rows in the list, the Hidden count grows by the rows that moved there.
 */
export function patchInbox(
  payload: InboxPayload,
  keys: readonly SubjectKey[],
  op: StateOp,
  now: string,
  opts: { includeHidden?: boolean } = {},
): InboxPayload {
  const includeHidden = opts.includeHidden ?? payload.rows.some((r) => r.section === "hidden");
  const targets = new Set(keys);
  let movedToHidden = 0;
  const rows: InboxRow[] = [];
  for (const row of payload.rows) {
    if (!targets.has(row.key)) {
      rows.push(row);
      continue;
    }
    const patched = patchRow(row, op, now, { includeHidden });
    if (row.section !== "hidden" && (patched === null || patched.section === "hidden")) movedToHidden += 1;
    if (patched !== null) rows.push(patched);
  }
  rows.sort(compareRows);
  const sections = sectionCounts(rows);
  if (!includeHidden) sections.hidden = payload.sidebar.sections.hidden + movedToHidden;
  return { ...payload, rows, sidebar: { sections, repos: repoCounts(rows) } };
}

const STATE_OP_KINDS: ReadonlySet<string> = new Set<StateOpKind>([
  "done",
  "read",
  "unread",
  "snooze",
  "unsnooze",
  "mute",
  "unmute",
  "unsubscribe",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a request body's `op`. Snooze needs a parseable `until` or a wake condition. */
export function isValidStateOp(value: unknown): value is StateOp {
  if (!isRecord(value) || typeof value.kind !== "string" || !STATE_OP_KINDS.has(value.kind)) return false;
  if (value.kind !== "snooze") return Object.keys(value).length === 1;
  const { until, untilHumanEvent, untilReady } = value;
  if (Object.keys(value).length !== 4) return false;
  if (typeof untilHumanEvent !== "boolean" || typeof untilReady !== "boolean") return false;
  if (until === null) return untilHumanEvent || untilReady;
  return typeof until === "string" && !Number.isNaN(Date.parse(until));
}
