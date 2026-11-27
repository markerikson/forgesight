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

/**
 * Reads one listing to the end. Returns null when the budget runs out first, so a partial
 * listing is never treated as complete.
 */
async function readListing(
  ctx: JobContext,
  pages: AsyncIterable<NotificationThread[]>,
  stopWhen: (seen: Map<string, string>) => boolean = () => false,
): Promise<Map<string, string> | null> {
  const seen = new Map<string, string>();
  for await (const page of pages) {
    for (const t of page) seen.set(t.id, t.updatedAt);
    if (stopWhen(seen)) return seen;
    if (!ctx.governor.canSpend("rest", "doneSync")) return null;
  }
  return seen;
}

/**
 * Notices threads marked done outside Forgesight (github.com, the mobile app) and marks them done
 * here, every `polling.doneSyncMinutes`.
 *
 * GitHub's `all=true` listings keep showing done threads, and marking done does not change
 * `updated_at`, so the regular poll cannot see it. Instead:
 * 1. Candidates are local threads from the last `backfillDays` that are not done here or on GitHub.
 * 2. One `is_done=false` listing since the oldest candidate. Candidates missing from it, or listed
 *    with a different `updated_at`, are suspects. This listing is small: it is the GitHub inbox.
 * 3. One `is_done=true` listing since the oldest suspect, stopping once every suspect is found.
 *    Only threads found there, with the same `updated_at` as ours, are marked done.
 *
 * Step 3 is what makes a thread done, so a partial or racing listing in step 2 can only cost an
 * extra request, never a wrong Done. A suspect that step 3 does not find (for example a thread
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

    const notDone = await readListing(ctx, gh.listNotificationsByDone(false, new Date(oldest.updatedAt)));
    if (!notDone) return "worked";

    const unconfirmed = readUnconfirmed(ctx);
    const suspects = candidates.filter((c) => {
      if (notDone.get(c.threadId) === c.updatedAt) return false;
      const prev = unconfirmed[c.threadId];
      return !(
        prev &&
        prev.updatedAt === c.updatedAt &&
        now.getTime() - Date.parse(prev.checkedAt) < UNCONFIRMED_RECHECK_MS
      );
    });

    const confirmed: DoneCandidate[] = [];
    const oldestSuspect = suspects[0];
    if (oldestSuspect) {
      const wanted = new Map(suspects.map((s) => [s.threadId, s]));
      const done = await readListing(
        ctx,
        gh.listNotificationsByDone(true, new Date(oldestSuspect.updatedAt)),
        (seen) => [...wanted.keys()].every((id) => seen.has(id)),
      );
      for (const [id, updatedAt] of done ?? []) {
        const suspect = wanted.get(id);
        if (suspect && suspect.updatedAt === updatedAt) confirmed.push(suspect);
      }
      if (!done) {
        const marked = applyExternalDone(db, confirmed, now.toISOString());
        if (marked.length > 0) log.info(`doneSync: ${marked.length} subjects done on GitHub (partial listing)`);
        return "worked";
      }
    }

    const nowIso = now.toISOString();
    const confirmedIds = new Set(confirmed.map((c) => c.threadId));
    const suspectIds = new Set(suspects.map((s) => s.threadId));
    const nextUnconfirmed: Unconfirmed = {};
    for (const c of candidates) {
      if (suspectIds.has(c.threadId)) {
        if (!confirmedIds.has(c.threadId)) nextUnconfirmed[c.threadId] = { updatedAt: c.updatedAt, checkedAt: nowIso };
      } else {
        // Skipped this run because of a recent unconfirmed entry: keep that entry.
        const prev = notDone.get(c.threadId) === c.updatedAt ? undefined : unconfirmed[c.threadId];
        if (prev) nextUnconfirmed[c.threadId] = prev;
      }
    }

    const marked = db.transaction(() => {
      const marked = applyExternalDone(db, confirmed, nowIso);
      setMeta(db, META.doneSyncUnconfirmed, JSON.stringify(nextUnconfirmed), nowIso);
      setMeta(db, META.doneSyncAt, nowIso, nowIso);
      return marked;
    })();
    log.info(
      `doneSync: ${candidates.length} candidates, ${suspects.length} missing from the GitHub inbox, ` +
        `${marked.length} subjects marked done`,
    );
    return "worked";
  },
};
