import { isRestack } from "./classify.ts";
import type { EventKind, InboxRow, QuietActivity, ViewEvent } from "./types.ts";

const PUSH_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["commit", "forcePush", "baseForcePush"]);
const LABEL_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["labeled", "milestoned"]);

/** Counts the new events the view collapses or hides, so a hidden subject can say what it is hiding. */
export function quietActivity(events: readonly ViewEvent[]): QuietActivity {
  const quiet: QuietActivity = { bots: 0, pushes: 0, rebases: 0, labels: 0, other: 0 };
  for (const e of events) {
    if (!e.isNew || e.level === "show") continue;
    if (e.kind === "forcePush" && isRestack(e)) quiet.rebases++;
    else if (PUSH_KINDS.has(e.kind)) quiet.pushes++;
    else if (LABEL_KINDS.has(e.kind)) quiet.labels++;
    else if (e.actor?.isBot || e.botKind) quiet.bots++;
    else quiet.other++;
  }
  return quiet;
}

const QUIET_NOUNS: Record<keyof QuietActivity, string> = {
  bots: "bot activity",
  pushes: "pushes",
  rebases: "rebases",
  labels: "label changes",
  other: "minor events",
};

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function quietLine(quiet: QuietActivity | undefined): string {
  if (!quiet) return "nothing new since your last visit";
  const kinds = (Object.keys(QUIET_NOUNS) as (keyof QuietActivity)[]).filter((k) => quiet[k] > 0);
  if (kinds.length === 0) return "nothing new since your last visit";
  return `only ${joinWithAnd(kinds.map((k) => QUIET_NOUNS[k]))}`;
}

export type HiddenReasonInput = Pick<InboxRow, "section" | "reasons" | "merged" | "quiet">;

/**
 * Why a subject sits in Hidden, in plain words, from its rank reasons and quiet activity.
 * Null when it is not hidden.
 */
export function hiddenReason(row: HiddenReasonInput): string | null {
  if (row.section !== "hidden") return null;
  const { reasons } = row;
  if (reasons.includes("muted")) return "muted";
  if (reasons.includes("closedByAuthor")) return "closed by its author without merging";
  if (reasons.includes("closedByOthers")) {
    return row.merged ? "merged, no new comments" : "closed, no new comments";
  }
  return quietLine(row.quiet);
}
