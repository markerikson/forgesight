import type { Database } from "bun:sqlite";
import { configHash } from "../config/load.ts";
import type { Config } from "../core/config.ts";
import { META } from "../core/meta-keys.ts";
import { deriveSubjectView, PIPELINE_VERSION, toViewRecord } from "../core/pipeline/index.ts";
import type { SubjectViewRecord } from "../core/types.ts";
import { DEFAULT_ITEM_STATE, getItemStates, snoozesEndedBetween } from "../store/item-state.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { getSubject } from "../store/subjects.ts";
import { threadsForSubject } from "../store/threads.ts";
import { reviewThreadsFor, stickiesFor, timelineFor } from "../store/timeline.ts";
import { changesAfter, putViews, staleViewKeys } from "../store/views.ts";
import type { Job, Logger } from "./scheduler.ts";

export const DERIVE_BATCH = 200;

export interface DeriveSummary {
  derived: number;
  changed: number;
  failed: number;
  ms: number;
}

/**
 * Subjects whose view needs recomputing: views missing or from another pipeline version or
 * config, raw data or user state changed since the last run, or a snooze that has ended.
 */
function pendingKeys(
  db: Database,
  hash: string,
  now: string,
): { keys: string[]; maxSeq: number | null } {
  const keys = new Set(staleViewKeys(db, PIPELINE_VERSION, hash));
  const lastSeq = Number(getMeta(db, META.deriveSeq) ?? "0");
  let maxSeq: number | null = null;
  for (const c of changesAfter(db, lastSeq)) {
    maxSeq = c.seq;
    if ((c.kind === "raw" || c.kind === "state") && c.subjectKey) keys.add(c.subjectKey);
  }
  for (const key of snoozesEndedBetween(db, getMeta(db, META.deriveAt) ?? null, now)) {
    keys.add(key);
  }
  return { keys: [...keys].sort(), maxSeq };
}

function deriveBatch(
  db: Database,
  keys: string[],
  ctx: { config: Config; hash: string; now: Date; log: Logger },
): { views: SubjectViewRecord[]; failed: number } {
  const states = getItemStates(db, keys);
  const computedAt = ctx.now.toISOString();
  const views: SubjectViewRecord[] = [];
  let failed = 0;
  for (const key of keys) {
    const subject = getSubject(db, key);
    if (!subject) continue;
    try {
      const view = deriveSubjectView({
        subject,
        threads: threadsForSubject(db, key),
        items: timelineFor(db, key),
        reviewThreads: reviewThreadsFor(db, key),
        stickies: stickiesFor(db, key),
        state: states.get(key) ?? { ...DEFAULT_ITEM_STATE },
        config: ctx.config,
        me: ctx.config.me,
        now: ctx.now,
      });
      views.push(
        toViewRecord(view, { pipelineVersion: PIPELINE_VERSION, configHash: ctx.hash, computedAt }),
      );
    } catch (e) {
      failed++;
      ctx.log.warn(`derive ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { views, failed };
}

/** Recomputes every pending view in batches of `DERIVE_BATCH`, one transaction each. */
export function deriveViews(
  db: Database,
  config: Config,
  now: Date,
  log: Logger,
): DeriveSummary {
  const started = performance.now();
  const hash = configHash(config);
  const nowIso = now.toISOString();
  const { keys, maxSeq } = pendingKeys(db, hash, nowIso);
  let changed = 0;
  let failed = 0;
  for (let i = 0; i < keys.length; i += DERIVE_BATCH) {
    const batch = deriveBatch(db, keys.slice(i, i + DERIVE_BATCH), { config, hash, now, log });
    failed += batch.failed;
    changed += putViews(db, batch.views, nowIso).length;
  }
  if (maxSeq !== null) setMeta(db, META.deriveSeq, String(maxSeq), nowIso);
  setMeta(db, META.deriveAt, nowIso, nowIso);
  const ms = Math.round(performance.now() - started);
  if (keys.length > 0) {
    log.info(`derive: ${keys.length} subjects, ${changed} list changes, ${failed} failed, ${ms}ms`);
  }
  return { derived: keys.length - failed, changed, failed, ms };
}

export const deriveJob: Job = {
  name: "derive",
  async run(ctx) {
    const summary = deriveViews(ctx.db, ctx.config, ctx.clock(), ctx.log);
    // Failures stay stale and are retried next tick; counting them as work would spin drain().
    return summary.derived > 0 ? "worked" : "idle";
  },
};
