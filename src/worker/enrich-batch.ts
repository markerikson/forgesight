import type { Database } from "bun:sqlite";
import type { WorkClass } from "../core/budget.ts";
import type { RepoMode } from "../core/config.ts";
import {
  type BatchState,
  isExhausted,
  nextBatchSize,
  queryShape,
  type StickyMarker,
  timelineSince,
} from "../core/enrich-plan.ts";
import type { EnrichmentResult, SubjectRecord } from "../core/types.ts";
import { GqlError, RateLimitedError, TokenError } from "../github/errors.ts";
import {
  type BatchSubject,
  buildSubjectBatchQuery,
  errorsByAlias,
  type ParsedAlias,
  type ParsedSticky,
  parseStickies,
  parseSubjectAlias,
  parseTimelinePage,
} from "../github/queries/subject-batch.ts";
import type { GitHubClient, GqlErrorEntry, GqlResult } from "../github/types.ts";
import { recordEnrichError, recordNotFound, saveEnrichment } from "../store/subjects.ts";

export interface EnrichSubject {
  subjectKey: string;
  kind: "pr" | "issue";
  number: number;
  since: string | null;
}

export interface EnrichBatchInput {
  repo: string;
  mode: RepoMode;
  subjects: EnrichSubject[];
  /** Stored sticky comment ids per subject, re-read with every enrichment. */
  stickyIds: Map<string, string[]>;
  state: BatchState;
  maxSize: number;
  markers: StickyMarker[];
  workClass: WorkClass;
}

export type SubjectOutcome =
  | { kind: "ok"; subjectKey: string; result: EnrichmentResult }
  | { kind: "notFound"; subjectKey: string }
  | { kind: "error"; subjectKey: string; error: string };

export interface EnrichBatchResult {
  outcomes: SubjectOutcome[];
  /** Batch state after this run, to persist for the repo. */
  state: BatchState;
  cost: number;
  queries: number;
}

export interface EnrichBatchDeps {
  graphql: GitHubClient["graphql"];
  clock?: () => Date;
}

interface BatchData {
  repository: Record<string, unknown> | null;
  stickies: unknown;
}

/** What to fetch for a stored subject. Null for kinds that are never enriched. */
export function enrichSubjectFor(subject: SubjectRecord, dismissedAt: string | null, now: Date): EnrichSubject | null {
  if (subject.kind === "other" || subject.number === null) return null;
  return {
    subjectKey: subject.subjectKey,
    kind: subject.kind,
    number: subject.number,
    since: timelineSince({ timelineSyncedUntil: subject.timelineSyncedUntil, dismissedAt, now }),
  };
}

function messageOf(errors: GqlErrorEntry[]): string {
  return errors.map((e) => (e.type ? `${e.type}: ${e.message}` : e.message)).join("; ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isShrinkable(error: unknown): error is GqlError {
  return error instanceof GqlError && (error.kind === "gateway" || error.kind === "timeout");
}

/** Errors that stop the whole run instead of failing one subject. */
function isFatal(error: unknown): boolean {
  if (error instanceof RateLimitedError || error instanceof TokenError) return true;
  return error instanceof GqlError && !isShrinkable(error);
}

/**
 * Enriches one repo's subjects with SubjectBatch queries, `state.size` subjects per query.
 * Gateway errors and timeouts shrink the batch and retry; a subject that still fails at size 1
 * with the reduced field set gets an error outcome. Timelines with more pages are fetched one
 * subject at a time. Other errors (rate limits, auth, bad queries) are thrown.
 */
export async function enrichRepoBatch(deps: EnrichBatchDeps, input: EnrichBatchInput): Promise<EnrichBatchResult> {
  const clock = deps.clock ?? (() => new Date());
  const outcomes: SubjectOutcome[] = [];
  const queue = [...input.subjects];
  let state = input.state;
  let cost = 0;
  let queries = 0;

  const query = async (subjects: BatchSubject[], stickyIds: string[]): Promise<GqlResult<BatchData>> => {
    const built = buildSubjectBatchQuery({
      repo: input.repo,
      subjects,
      stickyIds,
      shape: queryShape(input.mode, state.reduced),
    });
    queries++;
    const result = await deps.graphql<BatchData>(built.query, built.variables, {
      repo: input.repo,
      workClass: input.workClass,
    });
    cost += result.cost;
    return result;
  };

  const restOfTimeline = async (subject: EnrichSubject, first: ParsedAlias, fetchedAt: string): Promise<ParsedAlias> => {
    const merged = { ...first, items: [...first.items], stickies: [...first.stickies] };
    const seen = new Set(merged.items.map((i) => i.nodeId));
    let cursor = first.hasNextPage ? first.endCursor : null;
    while (cursor) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await query([{ ...subject, after: cursor }], []);
      const raw = result.data?.repository?.s0;
      if (raw == null) {
        throw new Error(messageOf(result.errors ?? []) || "timeline page missing from response");
      }
      const page = parseTimelinePage(raw, { fetchedAt, markers: input.markers });
      for (const item of page.items) {
        if (seen.has(item.nodeId)) continue;
        seen.add(item.nodeId);
        merged.items.push(item);
      }
      merged.stickies.push(...page.stickies);
      cursor = page.hasNextPage ? page.endCursor : null;
    }
    merged.hasNextPage = false;
    merged.endCursor = null;
    return merged;
  };

  while (queue.length) {
    const chunk = queue.slice(0, Math.max(1, state.size));
    const stickyIds = chunk.flatMap((s) => input.stickyIds.get(s.subjectKey) ?? []);
    const startedAt = clock().toISOString();
    let result: GqlResult<BatchData>;
    try {
      // oxlint-disable-next-line no-await-in-loop
      result = await query(chunk, stickyIds);
    } catch (error) {
      if (!isShrinkable(error)) throw error;
      if (isExhausted(state)) {
        const [failed] = queue.splice(0, 1);
        if (failed) outcomes.push({ kind: "error", subjectKey: failed.subjectKey, error: errorText(error) });
        continue;
      }
      state = nextBatchSize(state, error.kind === "timeout" ? "timeout" : "gateway", input.maxSize);
      continue;
    }
    queue.splice(0, chunk.length);
    const shrink = result.gatewayErrors > 0 && state.size > 1;
    state = nextBatchSize(state, shrink ? "gateway" : "ok", input.maxSize);

    const byAlias = errorsByAlias(result.errors);
    const general = byAlias.get("") ?? [];
    let freshStickies: Map<string, ParsedSticky>;
    try {
      freshStickies = parseStickies(result.data?.stickies);
    } catch {
      freshStickies = new Map();
    }

    for (const [i, subject] of chunk.entries()) {
      const alias = `s${i}`;
      const raw = result.data?.repository?.[alias];
      const errors = byAlias.get(alias) ?? [];
      if (raw == null) {
        if ([...errors, ...general].some((e) => e.type === "NOT_FOUND")) {
          outcomes.push({ kind: "notFound", subjectKey: subject.subjectKey });
        } else {
          const error = messageOf([...errors, ...general]) || "subject missing from response";
          outcomes.push({ kind: "error", subjectKey: subject.subjectKey, error });
        }
        continue;
      }
      try {
        const ctx = { fetchedAt: startedAt, markers: input.markers };
        // oxlint-disable-next-line no-await-in-loop
        const parsed = await restOfTimeline(subject, parseSubjectAlias(raw, subject.kind, ctx), startedAt);
        const stickies = new Map(parsed.stickies.map((s) => [s.commentNodeId, s]));
        for (const id of input.stickyIds.get(subject.subjectKey) ?? []) {
          const fresh = freshStickies.get(id);
          if (fresh) stickies.set(id, fresh);
        }
        const enrichment: EnrichmentResult = {
          subjectKey: subject.subjectKey,
          subject: parsed.subject,
          timelineItems: parsed.items,
          stickies: [...stickies.values()],
          timelineSyncedUntil: startedAt,
        };
        if (parsed.reviewThreads) enrichment.reviewThreads = parsed.reviewThreads;
        outcomes.push({ kind: "ok", subjectKey: subject.subjectKey, result: enrichment });
      } catch (error) {
        if (isFatal(error)) throw error;
        outcomes.push({ kind: "error", subjectKey: subject.subjectKey, error: errorText(error) });
      }
    }
  }

  return { outcomes, state, cost, queries };
}

/** Writes batch outcomes to the store. */
export function applyEnrichOutcomes(db: Database, outcomes: SubjectOutcome[], now: string): void {
  for (const outcome of outcomes) {
    if (outcome.kind === "ok") saveEnrichment(db, outcome.result, now);
    else if (outcome.kind === "notFound") recordNotFound(db, outcome.subjectKey);
    else recordEnrichError(db, outcome.subjectKey, outcome.error, now);
  }
}
