import type { WorkClass } from "./budget.ts";
import type { Config, RepoMode } from "./config.ts";
import type { SubjectOrigin } from "./types.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Successful batches in a row before the batch size doubles. */
export const GROW_AFTER = 50;

/** Adaptive batch size for one repo, persisted between runs. */
export interface BatchState {
  size: number;
  successes: number;
  /** Fetch the reduced field set. Only reached at size 1. */
  reduced: boolean;
}

export type BatchOutcome = "ok" | "gateway" | "timeout";

export function initialBatchState(max: number): BatchState {
  return { size: Math.max(1, max), successes: 0, reduced: false };
}

/**
 * Doubles after GROW_AFTER successes, halves on a gateway error or timeout, and drops to the
 * reduced field set when size 1 still fails. A failure at size 1 reduced leaves the state as is;
 * the caller records an error for that subject (see `isExhausted`).
 */
export function nextBatchSize(state: BatchState, outcome: BatchOutcome, max: number): BatchState {
  const limit = Math.max(1, max);
  if (outcome === "ok") {
    const successes = state.successes + 1;
    if (successes < GROW_AFTER) return { ...state, size: Math.min(state.size, limit), successes };
    if (state.reduced) return { size: state.size, successes: 0, reduced: false };
    return { size: Math.min(limit, state.size * 2), successes: 0, reduced: false };
  }
  if (state.size > 1) return { size: Math.max(1, Math.floor(state.size / 2)), successes: 0, reduced: state.reduced };
  if (!state.reduced) return { size: 1, successes: 0, reduced: true };
  return { ...state, successes: 0 };
}

/** True when a failing batch cannot shrink further. */
export function isExhausted(state: BatchState): boolean {
  return state.size <= 1 && state.reduced;
}

/** Which parts of a PR the SubjectBatch query fetches. */
export interface QueryShape {
  /** `contexts` lists every check; `rollup` fetches only the combined state. */
  checks: "contexts" | "rollup";
  /** `reviewThreads(last: N)`; 0 skips review threads. */
  reviewThreads: number;
  /** `timelineItems(first: N)` per page. */
  timelinePage: number;
}

export function queryShape(mode: RepoMode, reduced: boolean): QueryShape {
  const simple = mode === "simple";
  return {
    checks: simple || reduced ? "rollup" : "contexts",
    reviewThreads: simple ? 0 : reduced ? 20 : 50,
    timelinePage: reduced ? 30 : 100,
  };
}

/**
 * Lower bound for `timelineItems(since:)`. The first fetch starts a day before the subject was
 * dismissed and covers at least the last two days; later fetches start 5 minutes before the
 * previous fetch began. Null means fetch the whole timeline (never dismissed).
 */
export function timelineSince(input: {
  timelineSyncedUntil: string | null;
  dismissedAt: string | null;
  now: Date;
}): string | null {
  if (input.timelineSyncedUntil) {
    return new Date(Date.parse(input.timelineSyncedUntil) - 5 * MINUTE_MS).toISOString();
  }
  if (!input.dismissedAt) return null;
  const fromDismissed = Date.parse(input.dismissedAt) - DAY_MS;
  const twoDaysAgo = input.now.getTime() - 2 * DAY_MS;
  return new Date(Math.min(fromDismissed, twoDaysAgo)).toISOString();
}

/** Subjects whose newest notification is older than this enrich as `backfill` work. */
export const RECENT_ENRICH_DAYS = 14;

/**
 * Budget class for enriching one subject: `enrich` for stack members and subjects with a
 * notification updated in the last RECENT_ENRICH_DAYS, otherwise `backfill`.
 */
export function enrichWorkClass(input: {
  origin: SubjectOrigin;
  threadUpdatedAt: string | null;
  now: Date;
}): Extract<WorkClass, "enrich" | "backfill"> {
  if (input.origin === "stack") return "enrich";
  if (!input.threadUpdatedAt) return "backfill";
  const age = input.now.getTime() - Date.parse(input.threadUpdatedAt);
  return age < RECENT_ENRICH_DAYS * DAY_MS ? "enrich" : "backfill";
}

/** A body marker that identifies a sticky bot comment, optionally tied to one author. */
export interface StickyMarker {
  marker: string;
  /** Login without a `[bot]` suffix. Omitted: any author. */
  author?: string;
}

export const REPLAY_QA_MARKER: StickyMarker = { marker: "<!-- replay-qa-bot -->" };
export const DIFFLOUPE_MARKER: StickyMarker = { marker: "ai-review kind=summary", author: "github-actions" };

/** Markers from bot and content rules that produce findings, plus the built-in DiffLoupe and replay-qa markers. */
export function stickyMarkers(config: Pick<Config, "bots" | "contentRules">): StickyMarker[] {
  const out: StickyMarker[] = [DIFFLOUPE_MARKER, REPLAY_QA_MARKER];
  for (const rule of [...config.bots, ...config.contentRules]) {
    if (!rule.findings || !rule.match.htmlMarker) continue;
    const marker: StickyMarker = { marker: rule.match.htmlMarker };
    if (rule.match.author) marker.author = rule.match.author;
    if (!out.some((m) => m.marker === marker.marker && m.author === marker.author)) out.push(marker);
  }
  return out;
}

export interface CommentLike {
  typename: string;
  authorLogin: string | null;
  body: string;
}

function withoutCode(body: string): string {
  return body.replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "").replace(/`[^`\n]*`/g, "");
}

function bareLogin(login: string): string {
  return login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;
}

/**
 * True for an issue comment whose body carries a sticky marker outside code blocks and inline code,
 * posted by the marker's author when it names one.
 */
export function isStickyCandidate(comment: CommentLike, markers: StickyMarker[]): boolean {
  if (comment.typename !== "IssueComment" || !comment.authorLogin) return false;
  const login = bareLogin(comment.authorLogin);
  const text = withoutCode(comment.body);
  return markers.some((m) => (m.author === undefined || m.author === login) && text.includes(m.marker));
}
