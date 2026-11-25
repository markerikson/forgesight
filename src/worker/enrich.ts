import type { Database } from "bun:sqlite";
import type { WorkClass } from "../core/budget.ts";
import { type RepoConfig, repoConfig } from "../core/config.ts";
import {
  type BatchState,
  ENRICH_PRIORITY,
  ENRICH_TIERS,
  type EnrichTier,
  initialBatchState,
  pickEnrichBatch,
  stickyMarkers,
} from "../core/enrich-plan.ts";
import { batchMetaKey } from "../core/meta-keys.ts";
import type { SubjectKind, SubjectRecord } from "../core/types.ts";
import { getItemStates } from "../store/item-state.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { clearDirty, dirtyKeysOfKind, dirtyQueue, subjectsByKeys } from "../store/subjects.ts";
import { stickyNodeIds } from "../store/timeline.ts";
import {
  applyEnrichOutcomes,
  EnrichAbortedError,
  type EnrichBatchResult,
  type EnrichSubject,
  enrichRepoBatch,
  enrichSubjectFor,
} from "./enrich-batch.ts";
import type { Job, JobContext, JobResult } from "./scheduler.ts";
import { rebuildAndLog } from "./workstreams.ts";

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

interface BatchPlan {
  repo: string;
  rc: RepoConfig;
  state: BatchState;
  tier: EnrichTier;
  workClass: WorkClass;
  picked: SubjectRecord[];
}

/**
 * Picks the next batch across all repos with `pickEnrichBatch`: urgent subjects first, then
 * subjects with recent activity, then the backlog, skipping tiers the governor does not allow.
 * Null when nothing can run.
 */
function planBatch(ctx: JobContext, now: Date, tiers: readonly EnrichTier[]): BatchPlan | null {
  const { db, config } = ctx;
  const minPriority = tiers.includes("active") || tiers.includes("backlog") ? 0 : ENRICH_PRIORITY.urgent;
  const states = new Map<string, BatchState>();
  const stateFor = (repo: string) => {
    let state = states.get(repo);
    if (!state) {
      state = loadBatchState(db, repo, repoConfig(config, repo).batchSize);
      states.set(repo, state);
    }
    return state;
  };
  const pick = pickEnrichBatch(dirtyQueue(db, minPriority), now, {
    canSpend: (workClass) => ctx.governor.canSpend("graphql", workClass),
    batchSize: (repo) => stateFor(repo).size,
    tiers,
  });
  if (!pick) return null;
  return {
    repo: pick.repo,
    rc: repoConfig(config, pick.repo),
    state: stateFor(pick.repo),
    tier: pick.tier,
    workClass: pick.workClass,
    picked: subjectsByKeys(db, pick.keys),
  };
}

/**
 * Enriches one batch from the dirty queue per run, in `pickEnrichBatch` order across repos, up
 * to the repo's current batch size, all of one tier. `tiers` limits the queue the job looks at.
 * The full job also clears kind `other` subjects (and issues when `enrichIssues` is off)
 * without a fetch. After a batch with fetched subjects in an overview repo, the repo's
 * workstreams are rebuilt from the stored data, since enrichment can change the grouping.
 * Returns idle when the queue is empty or the governor blocks every queued subject.
 */
function createEnrichJob(name: string, tiers: readonly EnrichTier[]): Job {
  const full = tiers.length === ENRICH_TIERS.length;
  return {
    name,
    run: (ctx) => runEnrich(ctx, tiers, full),
  };
}

/**
 * Enriches subjects opened or refreshed in the UI. It runs first in every tick, so an opened
 * subject is fetched within about a second, ahead of polling and the backlog.
 */
export const urgentEnrichJob: Job = createEnrichJob("enrichUrgent", ["urgent"]);

/** Enriches the whole queue: urgent subjects, then recent activity, then the backlog. */
export const enrichJob: Job = createEnrichJob("enrich", ENRICH_TIERS);

async function runEnrich(ctx: JobContext, tiers: readonly EnrichTier[], full: boolean): Promise<JobResult> {
  const { db, config, clock, log } = ctx;
  const cleared = full ? clearUnenrichable(ctx) : 0;
  const now = clock();
  const plan = planBatch(ctx, now, tiers);
  if (!plan) return cleared > 0 ? "worked" : "idle";
  const { repo, rc, state, tier, workClass, picked } = plan;

  const states = getItemStates(
    db,
    picked.map((s) => s.subjectKey),
  );
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
        workClass,
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
    `enrich ${repo} (${tier}): ${counts.ok} ok, ${counts.notFound} not found, ${counts.error} failed; ` +
      `${result.queries} queries, ${result.cost} pts, batch ${result.state.size}${result.state.reduced ? " reduced" : ""}`,
  );
  if (result.state.size < state.size || (result.state.reduced && !state.reduced)) {
    log.warn(`enrich ${repo}: batch shrank from ${state.size} to ${result.state.size}`);
  }
  for (const o of result.outcomes) {
    if (o.kind === "error") log.warn(`enrich ${o.subjectKey}: ${o.error}`);
  }
  if (counts.ok > 0 && rc.view === "overview") rebuildAndLog(ctx, repo);
  return "worked";
}
