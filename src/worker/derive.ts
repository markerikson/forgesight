import type { Database } from "bun:sqlite";
import { configHash } from "../config/load.ts";
import type { Config } from "../core/config.ts";
import { META } from "../core/meta-keys.ts";
import { deriveSubjectView, PIPELINE_VERSION, toViewRecord } from "../core/pipeline/index.ts";
import type { SubjectViewRecord } from "../core/types.ts";
import { DEFAULT_ITEM_STATE, getItemStates, snoozesEndedBetween } from "../store/item-state.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { verdictsFor } from "../store/push-verdicts.ts";
import { getSubject } from "../store/subjects.ts";
import { threadsForSubject } from "../store/threads.ts";
import { reviewThreadsFor, stickiesFor, timelineFor } from "../store/timeline.ts";
import { appendChange, changesAfter, putViews, staleViewKeys } from "../store/views.ts";
import { stackContextsFor, workstreamSnoozesEndedBetween } from "../store/workstreams.ts";
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
    if ((c.kind === "raw" || c.kind === "state" || c.kind === "stack") && c.subjectKey) {
      keys.add(c.subjectKey);
    }
  }
  for (const key of snoozesEndedBetween(db, getMeta(db, META.deriveAt) ?? null, now)) {
    keys.add(key);
  }
  for (const key of failedKeys(db)) keys.add(key);
  return { keys: [...keys].sort(), maxSeq };
}

function failedKeys(db: Database): string[] {
  const raw = getMeta(db, META.deriveFailed);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function deriveBatch(
  db: Database,
  keys: string[],
  ctx: { config: Config; hash: string; now: Date; log: Logger },
): { views: SubjectViewRecord[]; failed: string[] } {
  const states = getItemStates(db, keys);
  const stacks = stackContextsFor(db, keys);
  const computedAt = ctx.now.toISOString();
  const views: SubjectViewRecord[] = [];
  const failed: string[] = [];
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
        stack: stacks.get(key) ?? null,
        pushVerdicts: verdictsFor(db, key),
      });
      views.push(
        toViewRecord(view, { pipelineVersion: PIPELINE_VERSION, configHash: ctx.hash, computedAt }),
      );
    } catch (e) {
      failed.push(key);
      ctx.log.warn(`derive ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { views, failed };
}

export interface DerivedKeys {
  views: SubjectViewRecord[];
  /** Keys whose stored view changed (a `view` change was appended). */
  changed: string[];
  failed: string[];
}

/**
 * Derives and stores the views for `keys` in batches of `DERIVE_BATCH`. Uses only the store
 * and the pure pipeline, so the web server calls it right after a state op.
 */
export function deriveKeys(
  db: Database,
  keys: string[],
  config: Config,
  now: Date,
  log: Logger = console,
): DerivedKeys {
  const hash = configHash(config);
  const nowIso = now.toISOString();
  const result: DerivedKeys = { views: [], changed: [], failed: [] };
  for (let i = 0; i < keys.length; i += DERIVE_BATCH) {
    const batch = deriveBatch(db, keys.slice(i, i + DERIVE_BATCH), { config, hash, now, log });
    result.views.push(...batch.views);
    result.failed.push(...batch.failed);
    result.changed.push(...putViews(db, batch.views, nowIso));
  }
  return result;
}

/** Recomputes every pending view in batches of `DERIVE_BATCH`, one transaction each. */
export function deriveViews(
  db: Database,
  config: Config,
  now: Date,
  log: Logger,
): DeriveSummary {
  const started = performance.now();
  const nowIso = now.toISOString();
  const { keys, maxSeq } = pendingKeys(db, configHash(config), nowIso);
  const derived = deriveKeys(db, keys, config, now, log);
  const changed = derived.changed.length;
  const failed = derived.failed;
  if (maxSeq !== null) setMeta(db, META.deriveSeq, String(maxSeq), nowIso);
  // A workstream snooze that lapses writes nothing, so announce it for the inbox to regroup.
  for (const id of workstreamSnoozesEndedBetween(db, getMeta(db, META.deriveAt) ?? null, nowIso)) {
    appendChange(db, "workstream", id, nowIso);
  }
  setMeta(db, META.deriveAt, nowIso, nowIso);
  // Failed keys are kept so the next run retries them even when their stored view is current.
  setMeta(db, META.deriveFailed, JSON.stringify(failed), nowIso);
  const ms = Math.round(performance.now() - started);
  if (keys.length > 0) {
    log.info(`derive: ${keys.length} subjects, ${changed} list changes, ${failed.length} failed, ${ms}ms`);
  }
  return { derived: keys.length - failed.length, changed, failed: failed.length, ms };
}

export const deriveJob: Job = {
  name: "derive",
  local: true,
  async run(ctx) {
    const summary = deriveViews(ctx.db, ctx.config, ctx.clock(), ctx.log);
    // Failures are retried next tick; counting them as work would spin drain().
    return summary.derived > 0 ? "worked" : "idle";
  },
};
