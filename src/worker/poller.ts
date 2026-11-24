import { repoConfig } from "../core/config.ts";
import { META } from "../core/meta-keys.ts";
import {
  initialDismissedAt,
  isRecent,
  planPoll,
  planSubjects,
  sinceFor,
  threadChanged,
  toThreadUpsert,
  type ThreadInput,
} from "../core/notifications.ts";
import type { NotificationThread } from "../github/types.ts";
import { initDismissedAt } from "../store/item-state.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { ensureSubjects, markDirty } from "../store/subjects.ts";
import { threadsByIds, upsertThreads } from "../store/threads.ts";
import type { Job, JobContext } from "./scheduler.ts";

/** `meta` keys the poller reads and writes. */
export const POLL_META = {
  etag: META.etag,
  nextPollAt: META.nextPollAt,
  lastPollStartedAt: META.lastPollStartedAt,
  lastFullAt: META.lastFullAt,
  lastCheckAt: META.lastCheckAt,
  requestedAt: META.pollRequestedAt,
  backfillStartedAt: META.backfillStartedAt,
  backfillCursor: META.backfillCursor,
  backfillCompletedAt: META.backfillCompletedAt,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IngestResult {
  /** Threads written: new, or changed in a column we keep. */
  written: number;
  /** Subjects queued for enrichment. */
  dirtied: number;
}

export interface Poller {
  pollJob: Job;
  backfillJob: Job;
  /** Make the next poll due and full, as the web refresh button does. */
  request(): void;
}

/**
 * The poll job checks page 1 with the stored ETag on GitHub's poll interval and fetches
 * `since=` the last poll when it changed, or every `fullRefreshMinutes` regardless. The
 * backfill job reads one page per tick back to `backfillDays` before the first run.
 */
export function createPoller(): Poller {
  // The first poll after a start skips the ETag and the in-process interval wait.
  let forced = true;
  let backfillPages: AsyncIterator<NotificationThread[]> | null = null;

  const pollJob: Job = {
    name: "notifications",
    stopOn403: true,
    async run(ctx) {
      const { db, gh, governor, config, clock } = ctx;
      const now = clock();
      const plan = planPoll(
        {
          nextPollAt: metaDate(ctx, POLL_META.nextPollAt),
          lastFullAt: metaDate(ctx, POLL_META.lastFullAt),
          lastCheckAt: metaDate(ctx, POLL_META.lastCheckAt),
          requestedAt: metaDate(ctx, POLL_META.requestedAt),
          forced,
        },
        now,
        config.polling.fullRefreshMinutes,
      );
      if (!plan.due || !governor.canSpend("rest", "notifications")) return "idle";

      const etag = plan.full ? undefined : getMeta(db, POLL_META.etag);
      const result = await gh.pollNotifications(etag ? { etag, force: forced } : { force: forced });
      forced = false;
      const nowIso = now.toISOString();
      setMeta(db, POLL_META.nextPollAt, result.nextPollAt.toISOString(), nowIso);
      setMeta(db, POLL_META.lastCheckAt, nowIso, nowIso);
      if (result.kind === "notModified") {
        // Any thread update moves it to the top of page 1, so an unchanged page 1 means
        // nothing changed since this check. Read and Done marks don't change the ETag;
        // the periodic full refresh picks those up.
        setMeta(db, POLL_META.lastPollStartedAt, nowIso, nowIso);
        return "worked";
      }

      const lastStarted = metaDate(ctx, POLL_META.lastPollStartedAt);
      const threads = [...result.threads];
      if (lastStarted) {
        for await (const page of gh.listNotificationsSince(sinceFor(lastStarted))) {
          threads.push(...page);
        }
      }
      const { written, dirtied } = ingest(ctx, newestById(threads), {
        firstRunAt: backfillDone(ctx) ? null : metaDate(ctx, POLL_META.backfillStartedAt),
        dirty: () => true,
      });
      setMeta(db, POLL_META.etag, result.etag, nowIso);
      setMeta(db, POLL_META.lastPollStartedAt, nowIso, nowIso);
      if (plan.full) setMeta(db, POLL_META.lastFullAt, nowIso, nowIso);
      if (written > 0) {
        ctx.log.info(
          `notifications: ${threads.length} fetched, ${written} written, ${dirtied} subjects queued${plan.full ? " (full)" : ""}`,
        );
      }
      return "worked";
    },
  };

  const backfillJob: Job = {
    name: "backfill",
    stopOn403: true,
    async run(ctx) {
      const { db, gh, governor, config, clock } = ctx;
      if (backfillDone(ctx) || !governor.canSpend("rest", "backfill")) return "idle";
      const now = clock();
      let startedAt = metaDate(ctx, POLL_META.backfillStartedAt);
      if (!startedAt) {
        startedAt = now;
        setMeta(db, POLL_META.backfillStartedAt, now.toISOString(), now.toISOString());
        ctx.log.info(`backfill: reading ${config.polling.backfillDays} days of notifications`);
      }
      const cutoff = new Date(startedAt.getTime() - config.polling.backfillDays * DAY_MS);
      backfillPages ??= gh.listNotificationsBefore(cutoff)[Symbol.asyncIterator]();

      let next: IteratorResult<NotificationThread[]>;
      try {
        next = await backfillPages.next();
      } catch (error) {
        // A generator that threw is finished; start over from page 1 on retry.
        backfillPages = null;
        throw error;
      }
      const nowIso = now.toISOString();
      if (next.done) {
        backfillPages = null;
        setMeta(db, POLL_META.backfillCompletedAt, nowIso, nowIso);
        ctx.log.info("backfill: complete");
        return "worked";
      }

      const firstRunAt = startedAt;
      const page = next.value;
      const { written, dirtied } = ingest(ctx, page, {
        firstRunAt,
        dirty: (t) => isRecent(t.updatedAt, firstRunAt),
      });
      const oldest = page.reduce<string | undefined>(
        (min, t) => (min === undefined || t.updatedAt < min ? t.updatedAt : min),
        undefined,
      );
      const cursor = getMeta(db, POLL_META.backfillCursor);
      if (oldest && (!cursor || oldest < cursor)) {
        setMeta(db, POLL_META.backfillCursor, oldest, nowIso);
      }
      ctx.log.info(
        `backfill: page of ${page.length}, ${written} written, ${dirtied} subjects queued, cursor ${oldest ?? cursor ?? "-"}`,
      );
      return "worked";
    },
  };

  return {
    pollJob,
    backfillJob,
    request() {
      forced = true;
    },
  };
}

/**
 * Writes the threads that changed, creates their subjects and initial item state, and
 * queues subjects whose newest thread is new or moved and passes `dirty`.
 */
export function ingest(
  ctx: Pick<JobContext, "db" | "config" | "clock">,
  threads: NotificationThread[],
  opts: { firstRunAt: Date | null; dirty: (thread: ThreadInput) => boolean },
): IngestResult {
  const { db, config } = ctx;
  const stored = threadsByIds(
    db,
    threads.map((t) => t.id),
  );
  const changed = threads.filter((t) => threadChanged(stored.get(t.id), t));
  if (changed.length === 0) return { written: 0, dirtied: 0 };

  const nowIso = ctx.clock().toISOString();
  const isPriorityRepo = (repo: string) => repoConfig(config, repo).mode === "full";
  let dirtied = 0;
  db.transaction(() => {
    const { changedSubjectKeys } = upsertThreads(db, changed.map(toThreadUpsert), nowIso);
    const moved = new Set(changedSubjectKeys);
    const plans = planSubjects(changed, isPriorityRepo);
    ensureSubjects(
      db,
      plans.map((p) => ({ ...p.subject, origin: "thread" as const })),
    );
    initDismissedAt(
      db,
      plans.map((p) => ({
        key: p.subject.subjectKey,
        dismissedAt: initialDismissedAt(p.thread, opts.firstRunAt),
      })),
      nowIso,
    );
    const byPriority = new Map<number, string[]>();
    for (const p of plans) {
      if (!moved.has(p.subject.subjectKey) || !opts.dirty(p.thread)) continue;
      const keys = byPriority.get(p.priority) ?? [];
      keys.push(p.subject.subjectKey);
      byPriority.set(p.priority, keys);
      dirtied++;
    }
    for (const [priority, keys] of byPriority) markDirty(db, keys, nowIso, priority);
  })();
  return { written: changed.length, dirtied };
}

function newestById(threads: NotificationThread[]): NotificationThread[] {
  const byId = new Map<string, NotificationThread>();
  for (const t of threads) {
    const prev = byId.get(t.id);
    if (!prev || t.updatedAt >= prev.updatedAt) byId.set(t.id, t);
  }
  return [...byId.values()];
}

function backfillDone(ctx: Pick<JobContext, "db">): boolean {
  return getMeta(ctx.db, POLL_META.backfillCompletedAt) !== undefined;
}

function metaDate(ctx: Pick<JobContext, "db">, key: string): Date | null {
  const value = getMeta(ctx.db, key);
  return value ? new Date(value) : null;
}
