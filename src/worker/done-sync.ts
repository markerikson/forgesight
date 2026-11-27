import { META } from "../core/meta-keys.ts";
import type { NotificationThread } from "../github/types.ts";
import { applyExternalDone, type DoneCandidate, doneCandidates } from "../store/external-done.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import type { Job, JobContext } from "./scheduler.ts";

const DAY_MS = 24 * 60 * 60_000;
/** How long a missing thread that the done listing did not confirm is left alone. */
const UNCONFIRMED_RECHECK_MS = DAY_MS;

/** Thread id → the `updated_at` it had and when the done listing failed to confirm it. */
type Unconfirmed = Record<string, { updatedAt: string; checkedAt: string }>;

function readUnconfirmed(ctx: JobContext): Unconfirmed {
  try {
    const parsed: unknown = JSON.parse(getMeta(ctx.db, META.doneSyncUnconfirmed) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Unconfirmed) : {};
  } catch {
    return {};
  }
}

function due(ctx: JobContext, now: Date): boolean {
  const at = Date.parse(getMeta(ctx.db, META.doneSyncAt) ?? "");
  return Number.isNaN(at) || now.getTime() - at >= ctx.config.polling.doneSyncMinutes * 60_000;
}

interface Listing {
  /** Thread id → `updated_at`. */
  seen: Map<string, string>;
  /** False when the budget ran out before the end (or before `stopWhen`). */
  complete: boolean;
}

async function readListing(
  ctx: JobContext,
  pages: AsyncIterable<NotificationThread[]>,
  stopWhen: (seen: Map<string, string>) => boolean = () => false,
): Promise<Listing> {
  const seen = new Map<string, string>();
  for await (const page of pages) {
    for (const t of page) seen.set(t.id, t.updatedAt);
    if (stopWhen(seen)) return { seen, complete: true };
    if (!ctx.governor.canSpend("rest", "doneSync")) return { seen, complete: false };
  }
  return { seen, complete: true };
}

/**
 * Notices threads marked done outside Forgesight (github.com, the mobile app) and marks them done
 * here, every `polling.doneSyncMinutes`.
 *
 * GitHub's `all=true` listings keep showing done threads, and marking done does not change
 * `updated_at`, so the regular poll cannot see it. Instead:
 * 1. Candidates are local threads from the last `backfillDays` that are not done here or on GitHub.
 * 2. One `is_done=false` listing since the oldest candidate. Candidates missing from it are
 *    suspects. This listing is small: it is the GitHub inbox.
 * 3. One `is_done=true` listing since the oldest suspect, stopping once every suspect is found.
 *    Only threads found there, with the same `updated_at` as ours, are marked done.
 *
 * Step 3 is what makes a thread done, so a racing listing in step 2 can only cost extra
 * requests, never a wrong Done. A run cut short by the budget still waits a full interval. A suspect that step 3 does not find (for example a thread
 * GitHub dropped) is skipped for a day so it does not force a long listing every run.
 */
export const doneSyncJob: Job = {
  name: "doneSync",
  async run(ctx) {
    const { db, config, clock, log, gh, governor } = ctx;
    const now = clock();
    if (!due(ctx, now)) return "idle";

    const windowStart = new Date(now.getTime() - config.polling.backfillDays * DAY_MS).toISOString();
    const candidates = doneCandidates(db, windowStart);
    const oldest = candidates[0];
    if (!oldest) {
      setMeta(db, META.doneSyncAt, now.toISOString(), now.toISOString());
      return "idle";
    }
    if (!governor.canSpend("rest", "doneSync")) return "idle";

    const nowIso = now.toISOString();
    const notDone = await readListing(ctx, gh.listNotificationsByDone(false, new Date(oldest.updatedAt)));
    if (!notDone.complete) {
      // Out of budget: wait for the next interval instead of restarting on the next tick.
      setMeta(db, META.doneSyncAt, nowIso, nowIso);
      return "worked";
    }

    const unconfirmed = readUnconfirmed(ctx);
    const recentlyUnconfirmed = (c: DoneCandidate) => {
      const prev = unconfirmed[c.threadId];
      return (
        prev !== undefined &&
        prev.updatedAt === c.updatedAt &&
        now.getTime() - Date.parse(prev.checkedAt) < UNCONFIRMED_RECHECK_MS
      );
    };
    // Any thread in the not-done listing is not done, whatever its `updated_at`: the poll will
    // pick up its new activity.
    const missing = candidates.filter((c) => !notDone.seen.has(c.threadId));
    const suspects = missing.filter((c) => !recentlyUnconfirmed(c));

    const confirmed: DoneCandidate[] = [];
    let doneComplete = true;
    const oldestSuspect = suspects[0];
    if (oldestSuspect) {
      const wanted = new Map(suspects.map((s) => [s.threadId, s]));
      const done = await readListing(
        ctx,
        gh.listNotificationsByDone(true, new Date(oldestSuspect.updatedAt)),
        (seen) => [...wanted.keys()].every((id) => seen.has(id)),
      );
      doneComplete = done.complete;
      for (const [id, updatedAt] of done.seen) {
        const suspect = wanted.get(id);
        if (suspect && suspect.updatedAt === updatedAt) confirmed.push(suspect);
      }
    }

    const nextUnconfirmed: Unconfirmed = {};
    const confirmedIds = new Set(confirmed.map((c) => c.threadId));
    for (const c of missing) {
      if (confirmedIds.has(c.threadId)) continue;
      const prev = unconfirmed[c.threadId];
      if (recentlyUnconfirmed(c) && prev) nextUnconfirmed[c.threadId] = prev;
      // A partial done listing did not check the rest, so they are not recorded as unconfirmed.
      else if (doneComplete) nextUnconfirmed[c.threadId] = { updatedAt: c.updatedAt, checkedAt: nowIso };
    }

    const marked = db.transaction(() => {
      const marked = applyExternalDone(db, confirmed, nowIso);
      setMeta(db, META.doneSyncUnconfirmed, JSON.stringify(nextUnconfirmed), nowIso);
      setMeta(db, META.doneSyncAt, nowIso, nowIso);
      return marked;
    })();
    log.info(
      `doneSync: ${candidates.length} candidates, ${missing.length} missing from the GitHub inbox, ` +
        `${marked.length} subjects marked done${doneComplete ? "" : " (done listing cut short by budget)"}`,
    );
    return "worked";
  },
};
