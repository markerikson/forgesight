// User state operations (Done, read, snooze, mute ...). The server applies them to stored
// item state; the client applies `patchInbox` to its cached inbox as an optimistic update.
import {
  groupSection,
  type InboxEntry,
  type InboxGroup,
  type InboxPayload,
  isGroup,
  keepsSection,
  settleInbox,
} from "./inbox.ts";
import type { InboxRow } from "./pipeline/types.ts";
import type { ItemState, SubjectKey } from "./types.ts";
import type { WorkstreamOp } from "./workstream-state.ts";

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

/** Most subject keys one state request may carry; the client splits larger requests. */
export const MAX_STATE_KEYS = 1000;

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
      return { ...state, ...NO_SNOOZE, dismissedAt: now, doneAt: now, readAt: now, keepUnread: false };
    case "read":
      return { ...state, dismissedAt: now, readAt: now, keepUnread: false };
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

/**
 * The unsent GitHub write an op cancels, given the item's state before the op. GitHub has
 * no "mark unread", so Keep unread can only stop a `read` that has not gone out yet. Unmute
 * cancels a waiting unsubscribe (and then resubscribes only threads whose unsubscribe was
 * sent), and unsubscribe or mute cancels a waiting resubscribe.
 */
export function cancelledOutboxOp(op: StateOp, state: ItemState): OutboxOp | null {
  switch (op.kind) {
    case "unread":
      return "read";
    case "unmute":
      return state.muted ? "unsubscribe" : null;
    case "unsubscribe":
      return "resubscribe";
    case "mute":
      return state.muted ? null : "resubscribe";
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

/**
 * The optimistic version of a list row after `op`, or null when the row leaves the list.
 * A row that moves to Hidden is returned with section `hidden` when `includeHidden` is set.
 * Done leaves every list, Hidden included, matching `isDoneQuiet`.
 * Mute keeps a snoozed row in Snoozed, matching `applyOverrides`.
 */
export function patchRow(
  row: InboxRow,
  op: StateOp,
  _now: string,
  opts: { includeHidden?: boolean } = {},
): InboxRow | null {
  const toHidden = (from: InboxRow = row): InboxRow | null =>
    opts.includeHidden ? { ...from, section: "hidden" } : null;
  switch (op.kind) {
    case "done":
      return null;
    case "mute":
    case "unsubscribe": {
      const muted = row.reasons.includes("muted") ? row : { ...row, reasons: [...row.reasons, "muted" as const] };
      return keepsSection(row) || row.section === "snoozed" ? muted : toHidden(muted);
    }
    case "unmute":
      return { ...row, reasons: row.reasons.filter((r) => r !== "muted") };
    case "snooze":
      return { ...row, section: "snoozed", snoozeUntil: op.until };
    case "read":
      return { ...row, unread: false, newMeaningfulCount: 0 };
    case "unread":
      return { ...row, unread: true };
    case "unsnooze":
      return { ...row };
  }
}

const listsHidden = (payload: InboxPayload) => payload.rows.some((r) => r.section === "hidden");

/**
 * Applies `patchRow` to the rows with `keys`, including rows listed inside a workstream
 * group, moves rows into or out of their groups, re-sorts, and recomputes the sidebar
 * counts. `includeHidden` defaults to whether the payload already lists any Hidden entry.
 * Without Hidden entries in the list, the Hidden count grows by the entries that moved there.
 */
export function patchInbox(
  payload: InboxPayload,
  keys: readonly SubjectKey[],
  op: StateOp,
  now: string,
  opts: { includeHidden?: boolean } = {},
): InboxPayload {
  const includeHidden = opts.includeHidden ?? listsHidden(payload);
  const targets = new Set(keys);
  const patch = (row: InboxRow): InboxRow[] => {
    if (!targets.has(row.key)) return [row];
    const next = patchRow(row, op, now, { includeHidden: true });
    return next ? [next] : [];
  };
  // A done member leaves the inbox, so its group stops showing it as unlisted too.
  const unlisted = (group: InboxGroup) =>
    op.kind === "done" ? group.unlisted.filter((u) => !targets.has(u.key)) : group.unlisted;
  const entries = payload.rows.flatMap<InboxEntry>((entry) =>
    isGroup(entry) ? [{ ...entry, members: entry.members.flatMap(patch), unlisted: unlisted(entry) }] : patch(entry),
  );
  return settleInbox(payload, entries, includeHidden);
}

/**
 * The optimistic version of the inbox after a workstream op on group `id`. Ops on a group
 * the payload does not list (a muted group outside the Hidden view) change nothing; the
 * server's response fills it in.
 */
export function patchWorkstream(
  payload: InboxPayload,
  id: string,
  op: WorkstreamOp,
  now: string,
  opts: { includeHidden?: boolean } = {},
): InboxPayload {
  const includeHidden = opts.includeHidden ?? listsHidden(payload);
  const target = payload.rows.find((e) => isGroup(e) && e.id === id) as InboxGroup | undefined;
  if (!target) return payload;
  const from =
    op.kind === "merge"
      ? (payload.rows.find((e) => isGroup(e) && e.id === op.from) as InboxGroup | undefined)
      : undefined;
  let changed = patchGroup(target, op, now);
  if (from) changed = { ...changed, memberKeys: [...changed.memberKeys, ...from.memberKeys] };
  const entries: InboxEntry[] = [];
  for (const entry of payload.rows) {
    if (entry === from) {
      // The merged-away group's members become loose rows that reflow into the target.
      entries.push(...from.members);
    } else if (entry !== target) {
      entries.push(entry);
    } else {
      entries.push(changed);
      if (op.kind === "remove") {
        const removed = target.members.find((m) => m.key === op.key);
        if (removed) entries.push(removed);
      }
    }
  }
  const returned = target.section === "hidden" && groupSection(changed) !== "hidden" ? 1 : 0;
  return settleInbox(payload, entries, includeHidden, returned);
}

/** The group after `op`. Merging other groups' members in is left to `patchWorkstream`. */
export function patchGroup(group: InboxGroup, op: WorkstreamOp, _now: string): InboxGroup {
  switch (op.kind) {
    case "setPriority":
      return { ...group, priority: op.priority, isNew: false };
    case "snooze":
      return { ...group, snoozed: true, snoozeUntil: op.until };
    case "unsnooze":
      return { ...group, snoozed: false, snoozeUntil: null };
    case "rename":
      return op.name ? { ...group, name: op.name } : group;
    case "seen":
      return { ...group, isNew: false, summary: group.summary && { ...group.summary, changed: false } };
    case "remove":
      return {
        ...group,
        memberKeys: group.memberKeys.filter((k) => k !== op.key),
        members: group.members.filter((m) => m.key !== op.key),
      };
    case "add":
      // The added row is loose in the payload and reflows into the group.
      return group.memberKeys.includes(op.key) ? group : { ...group, memberKeys: [...group.memberKeys, op.key] };
    case "merge":
      return group;
  }
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
