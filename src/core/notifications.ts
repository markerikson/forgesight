import { ENRICH_PRIORITY } from "./enrich-plan.ts";
import { subjectKeyFor } from "./keys.ts";
import type { SubjectKey, SubjectKind, ThreadRecord, ThreadUpsert } from "./types.ts";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Threads updated within this window at first run start undismissed and get enriched first. */
export const RECENT_WINDOW_MS = 14 * DAY_MS;
/** How far before `updated_at` the initial `dismissed_at` goes when GitHub has no `last_read_at`. */
export const UNREAD_LOOKBACK_MS = 2 * DAY_MS;
/** Overlap of each `since=` fetch with the previous one. */
export const SINCE_OVERLAP_MS = 2 * MINUTE_MS;

/** Reasons that put a subject at the front of the enrichment queue. */
const DIRECT_REASONS = new Set(["review_requested", "mention", "team_mention", "author", "comment"]);

const NUMBERED_SUBJECT = /\/repos\/[^/]+\/[^/]+\/(pulls|issues|discussions)\/(\d+)$/;
const KIND_BY_PATH: Record<string, SubjectKind> = { pulls: "pr", issues: "issue", discussions: "discussion" };

/** The thread fields this module reads; structurally matches the client's `NotificationThread`. */
export interface ThreadInput {
  id: string;
  repo: string;
  subjectType: string;
  subjectUrl: string | null;
  reason: string;
  unread: boolean;
  updatedAt: string;
  lastReadAt: string | null;
  raw: unknown;
}

export interface ThreadSubject {
  subjectKey: SubjectKey;
  repo: string;
  number: number | null;
  kind: SubjectKind;
}

export function subjectForThread(thread: ThreadInput): ThreadSubject {
  const match = thread.subjectUrl ? NUMBERED_SUBJECT.exec(thread.subjectUrl) : null;
  return {
    subjectKey: subjectKeyFor(thread),
    repo: thread.repo,
    number: match ? Number(match[2]) : null,
    kind: match ? (KIND_BY_PATH[match[1] ?? ""] ?? "other") : "other",
  };
}

export function toThreadUpsert(thread: ThreadInput): ThreadUpsert {
  return {
    threadId: thread.id,
    subjectKey: subjectKeyFor(thread),
    repo: thread.repo,
    subjectType: thread.subjectType,
    reason: thread.reason,
    unread: thread.unread,
    updatedAt: thread.updatedAt,
    lastReadAt: thread.lastReadAt,
    subjectUrl: thread.subjectUrl,
    raw: thread.raw,
  };
}

/** True when the incoming thread differs from the stored one in a column we keep. */
export function threadChanged(
  stored: Pick<ThreadRecord, "updatedAt" | "unread" | "lastReadAt" | "reason"> | undefined,
  incoming: Pick<ThreadUpsert, "updatedAt" | "unread" | "lastReadAt" | "reason">,
): boolean {
  return (
    !stored ||
    stored.updatedAt !== incoming.updatedAt ||
    stored.unread !== incoming.unread ||
    stored.lastReadAt !== incoming.lastReadAt ||
    stored.reason !== incoming.reason
  );
}

/** Enrichment queue priority for a moved thread: direct involvement, then priority repos. */
export function dirtyPriority(reason: string, priorityRepo: boolean): number {
  if (DIRECT_REASONS.has(reason)) return ENRICH_PRIORITY.direct;
  return priorityRepo ? ENRICH_PRIORITY.priorityRepo : ENRICH_PRIORITY.backlog;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The `dismissed_at` a subject gets when it first gets local state.
 * During backfill (`firstRunAt` set): `updated_at` when the thread was older than 14 days
 * at first run, else `last_read_at`, else `updated_at − 2 days`.
 * After backfill (`firstRunAt` null): `last_read_at`, else `updated_at − 2 days`.
 */
export function initialDismissedAt(
  thread: Pick<ThreadInput, "updatedAt" | "lastReadAt">,
  firstRunAt: Date | null,
): string {
  const updated = Date.parse(thread.updatedAt);
  if (firstRunAt && firstRunAt.getTime() - updated > RECENT_WINDOW_MS) return thread.updatedAt;
  return thread.lastReadAt ?? iso(updated - UNREAD_LOOKBACK_MS);
}

/** True when the thread was updated within 14 days of `at`. */
export function isRecent(updatedAt: string, at: Date): boolean {
  return at.getTime() - Date.parse(updatedAt) <= RECENT_WINDOW_MS;
}

export interface PollState {
  nextPollAt: Date | null;
  lastFullAt: Date | null;
  /** Last page-1 check, successful or not modified. */
  lastCheckAt: Date | null;
  /** From `poll.requestedAt` (web refresh button). */
  requestedAt: Date | null;
  /** In-process request, e.g. `--once`. */
  forced: boolean;
}

export type PollPlan =
  | { due: false }
  | {
      due: true;
      /** Skip the ETag and fetch `since=` even if page 1 is unchanged. */
      full: boolean;
      requested: boolean;
    };

/**
 * Whether to poll now. A refresh request (from web or in-process) makes the poll due
 * and full, so the user always gets a real `since=` fetch.
 */
export function planPoll(state: PollState, now: Date, fullRefreshMinutes: number): PollPlan {
  const requested =
    state.forced ||
    (state.requestedAt !== null &&
      (state.lastCheckAt === null || state.requestedAt > state.lastCheckAt));
  const due = requested || state.nextPollAt === null || now >= state.nextPollAt;
  if (!due) return { due: false };
  const full =
    requested ||
    state.lastFullAt === null ||
    now.getTime() - state.lastFullAt.getTime() >= fullRefreshMinutes * MINUTE_MS;
  return { due: true, full, requested };
}

/** Start of the next `since=` fetch, overlapping the previous one by two minutes. */
export function sinceFor(lastPollStartedAt: Date): Date {
  return new Date(lastPollStartedAt.getTime() - SINCE_OVERLAP_MS);
}

export interface SubjectPlan {
  subject: ThreadSubject;
  /** The newest thread for this subject in the batch. */
  thread: ThreadInput;
  priority: number;
}

/**
 * Groups threads by subject. Each subject keeps its newest thread (for `dismissed_at`)
 * and the highest priority over its threads.
 */
export function planSubjects(
  threads: ThreadInput[],
  isPriorityRepo: (repo: string) => boolean,
): SubjectPlan[] {
  const bySubject = new Map<SubjectKey, SubjectPlan>();
  for (const thread of threads) {
    const subject = subjectForThread(thread);
    const priority = dirtyPriority(thread.reason, isPriorityRepo(thread.repo));
    const prev = bySubject.get(subject.subjectKey);
    if (!prev) {
      bySubject.set(subject.subjectKey, { subject, thread, priority });
      continue;
    }
    if (Date.parse(thread.updatedAt) > Date.parse(prev.thread.updatedAt)) prev.thread = thread;
    prev.priority = Math.max(prev.priority, priority);
  }
  return [...bySubject.values()];
}
