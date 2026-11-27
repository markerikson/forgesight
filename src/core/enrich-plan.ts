import type { WorkClass } from "./budget.ts";
import type { Config, RepoMode } from "./config.ts";
import type { SubjectKind, SubjectOrigin } from "./types.ts";

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

/** Values of `subjects.priority`, the enrichment queue priority. Higher goes first. */
export const ENRICH_PRIORITY = {
  backlog: 0,
  priorityRepo: 1,
  direct: 2,
  /** Opened in the preview or refreshed by hand: fetch right away. */
  urgent: 3,
} as const;

export interface OpenedSubject {
  kind: SubjectKind;
  /** Start of the last successful fetch, null when never fetched. */
  timelineSyncedUntil: string | null;
  enrichError: string | null;
  /** The stored payload has no `body` (fetched before the query asked for it). */
  missingBody: boolean;
  /** Newest notification update for the subject, null when it has no thread. */
  threadUpdatedAt: string | null;
}

/** Whether the worker enriches subjects of this kind at all. */
export function isEnrichable(kind: SubjectKind, config: Pick<Config, "polling">): boolean {
  return kind === "pr" || kind === "discussion" || (kind === "issue" && config.polling.enrichIssues);
}

/**
 * Whether opening a subject in the preview should fetch it now: never fetched, fetched
 * without a body, or a notification arrived after the last fetch. A subject whose last
 * fetch failed is not refetched on open, so a deleted or failing subject does not refetch
 * on every view; the Refresh button still forces one.
 */
export function needsFetchOnOpen(subject: OpenedSubject, config: Pick<Config, "polling">): boolean {
  if (!isEnrichable(subject.kind, config) || subject.enrichError !== null) return false;
  if (subject.timelineSyncedUntil === null || subject.missingBody) return true;
  return (
    subject.threadUpdatedAt !== null && Date.parse(subject.threadUpdatedAt) > Date.parse(subject.timelineSyncedUntil)
  );
}

/** Enrichment queue tiers, in the order the worker drains them. */
export type EnrichTier = "urgent" | "active" | "backlog";
export const ENRICH_TIERS: readonly EnrichTier[] = ["urgent", "active", "backlog"];

/** One dirty subject in the enrichment queue. */
export interface QueuedSubject {
  subjectKey: string;
  repo: string;
  origin: SubjectOrigin;
  priority: number;
  dirtyAt: string;
  /** Newest notification update for the subject, null when it has no thread. */
  threadUpdatedAt: string | null;
}

/**
 * `urgent` for subjects opened or refreshed in the UI, `active` for subjects with recent
 * notification activity or in a stack, `backlog` for the rest.
 */
export function enrichTier(subject: QueuedSubject, now: Date): EnrichTier {
  if (subject.priority >= ENRICH_PRIORITY.urgent) return "urgent";
  return enrichWorkClass({ origin: subject.origin, threadUpdatedAt: subject.threadUpdatedAt, now }) === "enrich"
    ? "active"
    : "backlog";
}

/** Budget class for a tier. Urgent work uses the `enrich` class, so it still respects the soft cap. */
export function tierWorkClass(tier: EnrichTier): Extract<WorkClass, "enrich" | "backfill"> {
  return tier === "backlog" ? "backfill" : "enrich";
}

export interface EnrichBatchPick {
  repo: string;
  tier: EnrichTier;
  workClass: Extract<WorkClass, "enrich" | "backfill">;
  keys: string[];
}

export interface PickEnrichOptions {
  canSpend: (workClass: WorkClass) => boolean;
  batchSize: (repo: string) => number;
  /** Tiers to consider. Defaults to all of them. */
  tiers?: readonly EnrichTier[];
}

/**
 * Picks the next enrichment batch across all repos. The queue is ordered by tier, then
 * priority (highest first), then the time the subject was queued, then key. The first
 * subject whose tier the budget allows decides the repo and tier; the batch takes the next
 * subjects of that repo and tier, up to the repo's batch size.
 */
export function pickEnrichBatch(
  queue: readonly QueuedSubject[],
  now: Date,
  opts: PickEnrichOptions,
): EnrichBatchPick | null {
  const tiers = opts.tiers ?? ENRICH_TIERS;
  const ranked = queue
    .map((subject) => ({ subject, tier: enrichTier(subject, now) }))
    .filter((entry) => tiers.includes(entry.tier))
    .sort(
      (a, b) =>
        ENRICH_TIERS.indexOf(a.tier) - ENRICH_TIERS.indexOf(b.tier) ||
        b.subject.priority - a.subject.priority ||
        compareText(a.subject.dirtyAt, b.subject.dirtyAt) ||
        compareText(a.subject.subjectKey, b.subject.subjectKey),
    );
  const allowed = new Map<EnrichTier, boolean>();
  const first = ranked.find((entry) => {
    let ok = allowed.get(entry.tier);
    if (ok === undefined) {
      ok = opts.canSpend(tierWorkClass(entry.tier));
      allowed.set(entry.tier, ok);
    }
    return ok;
  });
  if (!first) return null;
  const { repo } = first.subject;
  const size = Math.max(1, opts.batchSize(repo));
  const keys = ranked
    .filter((entry) => entry.tier === first.tier && entry.subject.repo === repo)
    .slice(0, size)
    .map((entry) => entry.subject.subjectKey);
  return { repo, tier: first.tier, workClass: tierWorkClass(first.tier), keys };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
