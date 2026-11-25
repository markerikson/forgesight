import type { CiState, RankReason, ReviewDecision, SubjectKind, SubjectState } from "../core/index.ts";

export function repoShortName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "5m", "3h", "4d", then a short date. */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d`;
  return new Date(at).toISOString().slice(0, 10);
}

export interface RowByline {
  summary: string;
  /** The latest human actor, or null when the author or the summary already names them. */
  actor: string | null;
}

/**
 * Names each person on a row's second line once. The summary starts with its actor's
 * login; when that is the author, who is already shown, the login is dropped.
 */
export function rowByline(author: string | null, summaryLine: string, latestActor: string | null): RowByline {
  const startsWith = (login: string) => summaryLine.toLowerCase().startsWith(`${login.toLowerCase()} `);
  const summary = author && startsWith(author) ? summaryLine.slice(author.length + 1) : summaryLine;
  const named =
    latestActor === null ||
    (author !== null && latestActor.toLowerCase() === author.toLowerCase()) ||
    startsWith(latestActor);
  return { summary, actor: named ? null : latestActor };
}

export type StateTone = "open" | "draft" | "merged" | "closed" | "unknown";

export interface StateBadge {
  glyph: string;
  tone: StateTone;
  label: string;
}

export function stateBadge(
  kind: SubjectKind,
  state: SubjectState | null,
  draft: boolean,
  merged: boolean,
): StateBadge {
  if (kind === "pr") {
    if (merged || state === "MERGED") return { glyph: "◆", tone: "merged", label: "Merged pull request" };
    if (state === "CLOSED") return { glyph: "✕", tone: "closed", label: "Closed pull request" };
    if (draft) return { glyph: "◌", tone: "draft", label: "Draft pull request" };
    if (state === "OPEN") return { glyph: "●", tone: "open", label: "Open pull request" };
    return { glyph: "●", tone: "unknown", label: "Pull request" };
  }
  if (kind === "issue") {
    if (state === "CLOSED") return { glyph: "✓", tone: "merged", label: "Closed issue" };
    if (state === "OPEN") return { glyph: "○", tone: "open", label: "Open issue" };
    return { glyph: "○", tone: "unknown", label: "Issue" };
  }
  return { glyph: "·", tone: "unknown", label: "Notification" };
}

export const CI_LABELS: Record<CiState, string> = {
  success: "CI passed",
  failure: "CI failed",
  error: "CI errored",
  pending: "CI running",
  expected: "CI waiting",
};

export const REASON_LABELS: Record<RankReason, string> = {
  reviewRequested: "review requested",
  mentioned: "mentioned",
  assigned: "assigned",
  onMine: "mine",
  onMyReview: "I reviewed",
  participating: "participating",
  newActivity: "new activity",
  stateChange: "state changed",
  newIssue: "new issue",
  snoozed: "snoozed",
  muted: "muted",
  notEnriched: "not loaded yet",
  closedByOthers: "closed by others",
  closedByAuthor: "closed by author",
  keptUnread: "kept unread",
  staleReviewRequest: "old review request",
  nothingNew: "nothing new",
};

export const REVIEW_LABELS: Record<ReviewDecision, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};
