import type { Database } from "bun:sqlite";
import { repoConfig } from "../core/config.ts";
import { type BatchState, enrichWorkClass, initialBatchState, stickyMarkers } from "../core/enrich-plan.ts";
import { batchMetaKey } from "../core/meta-keys.ts";
import type { SubjectKind } from "../core/types.ts";
import { getItemStates } from "../store/item-state.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { clearDirty, dirtyKeysOfKind, nextDirtyBatch } from "../store/subjects.ts";
import { latestThreadUpdates } from "../store/threads.ts";
import { stickyNodeIds } from "../store/timeline.ts";
import {
  applyEnrichOutcomes,
  EnrichAbortedError,
  type EnrichBatchResult,
  type EnrichSubject,
  enrichRepoBatch,
  enrichSubjectFor,
} from "./enrich-batch.ts";
import type { Job, JobContext } from "./scheduler.ts";

/** Stored batch state for a repo, clamped to the configured maximum. */
export function loadBatchState(db: Database, repo: string, max: number): BatchState {
  const fallback = initialBatchState(max);
  const text = getMeta(db, batchMetaKey(repo));
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as Partial<BatchState>;
    if (typeof parsed.size !== "number" || parsed.size < 1) return fallback;
    return {
      size: Math.min(Math.floor(parsed.size), Math.max(1, max)),
      successes: typeof parsed.successes === "number" ? parsed.successes : 0,
      reduced: parsed.reduced === true,
    };
  } catch {
    return fallback;
  }
}

/** Takes subjects the enrich job never fetches off the queue. Returns how many were cleared. */
function clearUnenrichable(ctx: JobContext): number {
  const kinds: SubjectKind[] = ["other"];
  if (!ctx.config.polling.enrichIssues) kinds.push("issue");
  const keys = dirtyKeysOfKind(ctx.db, kinds);
  if (keys.length > 0) clearDirty(ctx.db, keys);
  return keys.length;
}

/**
 * Enriches one batch from the dirty queue per run: the repo of the highest-priority subject,
 * up to that repo's current batch size, all of one budget class. Kind `other` subjects (and
 * issues when `enrichIssues` is off) are cleared without a fetch. Returns idle when the queue
 * is empty or the governor blocks the class of every queued subject in that repo.
 */
export const enrichJob: Job = {
  name: "enrich",
  async run(ctx) {
    const { db, config, clock, log } = ctx;
    const cleared = clearUnenrichable(ctx);
    const [top] = nextDirtyBatch(db, { limit: 1 });
    if (!top) return cleared > 0 ? "worked" : "idle";

    const repo = top.repo;
    const rc = repoConfig(config, repo);
    const state = loadBatchState(db, repo, rc.batchSize);
    const now = clock();
    const candidates = nextDirtyBatch(db, { limit: state.size, repo });
    const keys = candidates.map((s) => s.subjectKey);
    const updates = latestThreadUpdates(db, keys);
    const classed = candidates.map((s) => ({
      subject: s,
      workClass: enrichWorkClass({ origin: s.origin, threadUpdatedAt: updates.get(s.subjectKey) ?? null, now }),
    }));
    const first = classed.find((c) => ctx.governor.canSpend("graphql", c.workClass));
    if (!first) return cleared > 0 ? "worked" : "idle";
    const picked = classed.filter((c) => c.workClass === first.workClass).map((c) => c.subject);

    const states = getItemStates(db, keys);
    const subjects: EnrichSubject[] = [];
    const skipped: string[] = [];
    for (const s of picked) {
      const es = enrichSubjectFor(s, states.get(s.subjectKey)?.dismissedAt ?? null, now);
      if (es) subjects.push(es);
      else skipped.push(s.subjectKey);
    }
    if (skipped.length > 0) clearDirty(db, skipped);
    if (subjects.length === 0) return "worked";

    const save = (result: EnrichBatchResult) => {
      const doneAt = clock().toISOString();
      applyEnrichOutcomes(db, result.outcomes, doneAt);
      setMeta(db, batchMetaKey(repo), JSON.stringify(result.state), doneAt);
    };
    let result: EnrichBatchResult;
    try {
      result = await enrichRepoBatch(
        { graphql: ctx.gh.graphql.bind(ctx.gh), clock },
        {
          repo,
          mode: rc.mode,
          subjects,
          stickyIds: stickyNodeIds(
            db,
            subjects.map((s) => s.subjectKey),
          ),
          state,
          maxSize: rc.batchSize,
          markers: stickyMarkers(config),
          workClass: first.workClass,
        },
      );
    } catch (error) {
      if (!(error instanceof EnrichAbortedError)) throw error;
      // Keep what finished before the failure; the scheduler handles the cause (backoff, stop on auth).
      save(error.partial);
      throw error.cause;
    }
    save(result);

    const counts = { ok: 0, notFound: 0, error: 0 };
    for (const o of result.outcomes) counts[o.kind]++;
    log.info(
      `enrich ${repo} (${first.workClass}): ${counts.ok} ok, ${counts.notFound} not found, ${counts.error} failed; ` +
        `${result.queries} queries, ${result.cost} pts, batch ${result.state.size}${result.state.reduced ? " reduced" : ""}`,
    );
    if (result.state.size < state.size || (result.state.reduced && !state.reduced)) {
      log.warn(`enrich ${repo}: batch shrank from ${state.size} to ${result.state.size}`);
    }
    for (const o of result.outcomes) {
      if (o.kind === "error") log.warn(`enrich ${o.subjectKey}: ${o.error}`);
    }
    return "worked";
  },
};
