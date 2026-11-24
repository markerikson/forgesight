import type { StateOp } from "../core/state.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 9:00" in the browser's time zone. */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function snoozeLabel(op: Extract<StateOp, { kind: "snooze" }>): string {
  if (op.untilReady) return "Snoozed until ready for review";
  if (op.until && op.untilHumanEvent) return `Snoozed until ${shortTime(op.until)} or someone replies`;
  if (op.until) return `Snoozed until ${shortTime(op.until)}`;
  return "Snoozed until someone replies";
}

function baseLabel(op: StateOp): string {
  switch (op.kind) {
    case "done":
      return "Done";
    case "read":
      return "Marked read";
    case "unread":
      return "Kept unread";
    case "snooze":
      return snoozeLabel(op);
    case "unsnooze":
      return "Unsnoozed";
    case "mute":
      return "Muted";
    case "unmute":
      return "Unmuted";
    case "unsubscribe":
      return "Muted and unsubscribed";
  }
}

/** Toast and undo-menu text for a state change: "Done", "Done: 14 items". */
export function opLabel(op: StateOp, count: number): string {
  const base = baseLabel(op);
  return count > 1 ? `${base}: ${count} items` : base;
}

export interface SnoozeChoice {
  label: string;
  op: StateOp;
}

function at9(day: Date): string {
  const d = new Date(day);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function addDays(now: Date, days: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d;
}

const snooze = (until: string | null, untilHumanEvent: boolean, untilReady = false): StateOp => ({
  kind: "snooze",
  until,
  untilHumanEvent,
  untilReady,
});

/** Snooze menu entries, numbered in this order. Times are local to the browser, sent as ISO. */
export function snoozeChoices(now: Date, opts: { draft: boolean; snoozed: boolean }): SnoozeChoice[] {
  const tomorrow = at9(addDays(now, 1));
  // Next Monday; on a Monday this is a week out.
  const monday = at9(addDays(now, ((8 - now.getDay()) % 7) || 7));
  const choices: SnoozeChoice[] = [
    { label: "3 hours", op: snooze(new Date(now.getTime() + 3 * 3600_000).toISOString(), false) },
    { label: "Tomorrow 9:00", op: snooze(tomorrow, false) },
    { label: "Monday 9:00", op: snooze(monday, false) },
    { label: "Until someone replies", op: snooze(null, true) },
    { label: "Tomorrow 9:00 or when someone replies", op: snooze(tomorrow, true) },
  ];
  if (opts.draft) choices.push({ label: "Until ready for review", op: snooze(null, false, true) });
  if (opts.snoozed) choices.push({ label: "Unsnooze", op: { kind: "unsnooze" } });
  return choices;
}
