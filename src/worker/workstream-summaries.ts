import type { Database } from "bun:sqlite";
import { openPullsMetaKey } from "../core/meta-keys.ts";
import { costUsd, utcDayStart } from "../core/summaries/cost.ts";
import {
  llmRetryDelayMs,
  prTextsToFetch,
  subjectNumber,
  SUMMARY_MIN_INTERVAL_MS,
  summaryDecision,
} from "../core/summaries/plan.ts";
import { OUTPUT_SCHEMAS } from "../core/summaries/schema.ts";
import {
  buildWorkstreamSummaryRequest,
  type MemberText,
  type MemberState,
  type SummaryRequest,
} from "../core/summaries/workstream.ts";
import type { SubjectKey } from "../core/types.ts";
import type { Workstream } from "../core/workstreams.ts";
import { fetchPrTexts, PR_TEXTS_MAX } from "../github/queries/pr-texts.ts";
import type { OpenPull, OpenPullsListing } from "../github/queries/open-pulls.ts";
import { LlmError, type LlmClient } from "../llm/types.ts";
import { parseWorkstreamSummary } from "../llm/validate.ts";
import {
  claimLlmJobs,
  completeLlmJob,
  enqueueLlmJob,
  failLlmJob,
  lastLlmJobFor,
  latestSummary,
  llmSpendSince,
  type LlmJobRecord,
  recordLlmCall,
  requeueStaleLlmJobs,
  saveSummary,
} from "../store/llm.ts";
import { getMeta } from "../store/meta.ts";
import { getPrTexts, type PrText, putPrTexts } from "../store/pr-texts.ts";
import { getSubject } from "../store/subjects.ts";
import { appendChange } from "../store/views.ts";
import { listWorkstreams, toWorkstream } from "../store/workstreams.ts";
import type { Job, JobContext } from "./scheduler.ts";

export const LLM_CONCURRENCY = 2;
export const LLM_MAX_ATTEMPTS = 3;
const SUMMARY_MAX_TOKENS = 400;
/** A job still marked running after this long belongs to a worker that died mid-call. */
const STALE_RUNNING_MS = 10 * 60 * 1000;

/** What a queued job stores: the request plus the model chosen when it was queued. */
interface StoredRequest extends SummaryRequest {
  model: string;
}

export interface WorkstreamSummariesDeps {
  /** `null` when no API key is set: texts still sync, nothing is sent to a model. */
  llm: LlmClient | null;
  /** Workstreams to summarize. Defaults to every stored workstream that is not archived. */
  workstreams?: (db: Database) => Workstream[];
}

const storedWorkstreams = (db: Database): Workstream[] => listWorkstreams(db).map(toWorkstream);

interface Listing {
  fetchedAt: string | null;
  pulls: Map<number, OpenPull>;
}

function readListing(db: Database, repo: string): Listing {
  const raw = getMeta(db, openPullsMetaKey(repo));
  if (!raw) return { fetchedAt: null, pulls: new Map() };
  const listing = JSON.parse(raw) as OpenPullsListing;
  return { fetchedAt: listing.fetchedAt, pulls: new Map(listing.pulls.map((p) => [p.number, p])) };
}

function membersByRepo(workstreams: Workstream[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const ws of workstreams) {
    const list = out.get(ws.repo) ?? [];
    for (const key of ws.members) {
      const n = subjectNumber(key);
      if (n !== null && !list.includes(n)) list.push(n);
    }
    out.set(ws.repo, list);
  }
  return out;
}

/**
 * The open listing is the freshest source. Otherwise the state saved with the text, which is
 * refetched once a newer listing drops the PR. Rows saved before the state column fall back to the
 * subject row, then to merged, the usual reason a PR leaves the listing.
 */
function memberState(
  db: Database,
  key: SubjectKey,
  text: PrText,
  listed: OpenPull | undefined,
): { state: MemberState; isDraft: boolean } {
  if (listed) return { state: "open", isDraft: listed.isDraft };
  if (text.state === "OPEN") return { state: "open", isDraft: text.isDraft };
  if (text.state === "CLOSED") return { state: "closed", isDraft: false };
  if (text.state === "MERGED") return { state: "merged", isDraft: false };
  const subject = getSubject(db, key);
  if (subject?.state === "OPEN") return { state: "open", isDraft: false };
  if (subject?.state === "CLOSED") return { state: "closed", isDraft: false };
  return { state: "merged", isDraft: false };
}

export interface WorkstreamSummaryJobs {
  /** GitHub job: keeps the stored PR texts current. */
  texts: Job;
  /** LLM job, null without an API key. It calls Anthropic, not GitHub, so it gets its own turn. */
  summaries: Job | null;
}

/**
 * Keeps workstream summaries current with two jobs that share state.
 *
 * The texts job fetches titles and descriptions for members whose stored copy is missing or older
 * than the open PR listing says, plus members stored as open that a newer listing no longer has
 * (GraphQL, `openPulls` budget class, up to 50 PRs per repo).
 *
 * The summaries job queues a summary when a workstream has none yet, or its input hash changed and
 * the last summary is at least 6 hours old (head SHAs are not part of the input, so pushes never
 * queue), then runs up to two queued calls at once while today's spend is under
 * `llm.dailyCapUsd`. Over the cap, jobs stay queued for the next UTC day and the last summary
 * stays shown.
 */
export function createWorkstreamSummaryJobs(deps: WorkstreamSummariesDeps): WorkstreamSummaryJobs {
  const loadShown = deps.workstreams ?? storedWorkstreams;
  /** PRs GitHub reports as not found; not asked for again until the worker restarts. */
  const unavailable = new Set<string>();
  let capLoggedFor: string | null = null;

  async function syncTexts(ctx: JobContext, workstreams: Workstream[]): Promise<boolean> {
    const { db, gh, governor, clock, log } = ctx;
    let fetched = false;
    for (const [repo, numbers] of membersByRepo(workstreams)) {
      const listed = readListing(db, repo);
      const wanted = prTextsToFetch(numbers, getPrTexts(db, repo, numbers), listed)
        .filter((n) => !unavailable.has(`${repo}#${n}`))
        .slice(0, PR_TEXTS_MAX);
      if (wanted.length === 0) continue;
      if (!governor.canSpend("graphql", "openPulls")) return fetched;
      // oxlint-disable-next-line no-await-in-loop -- one repo at a time keeps GraphQL spend serial
      const { texts, missing, failed } = await fetchPrTexts(gh, repo, wanted);
      const fetchedAt = clock().toISOString();
      putPrTexts(
        db,
        texts.map((t) => ({
          repo,
          number: t.number,
          title: t.title,
          body: t.body,
          updatedAt: t.updatedAt,
          fetchedAt,
          state: t.state,
          isDraft: t.isDraft,
        })),
      );
      for (const n of missing) unavailable.add(`${repo}#${n}`);
      log.info(`workstream summaries: fetched ${texts.length} PR texts for ${repo}`);
      if (failed.length > 0) log.warn(`workstream summaries: ${failed.length} PR texts for ${repo} failed; retrying later`);
      // A pass where every PR failed counts as idle, so the retry waits for the next tick.
      if (texts.length > 0 || missing.length > 0) fetched = true;
    }
    return fetched;
  }

  function queueSummaries(ctx: JobContext, workstreams: Workstream[]): number {
    const { db, config, clock } = ctx;
    const now = clock();
    const model = config.llm.tasks.workstreamSummary.model;
    const numbers = membersByRepo(workstreams);
    const textsByRepo = new Map<string, ReturnType<typeof getPrTexts>>();
    const listings = new Map<string, Listing>();
    let queued = 0;

    for (const ws of workstreams) {
      if (ws.members.length === 0) continue;
      const stored = textsByRepo.get(ws.repo) ?? getPrTexts(db, ws.repo, numbers.get(ws.repo) ?? []);
      textsByRepo.set(ws.repo, stored);
      const listed = listings.get(ws.repo) ?? readListing(db, ws.repo);
      listings.set(ws.repo, listed);

      const texts = new Map<SubjectKey, MemberText>();
      for (const key of ws.members) {
        const n = subjectNumber(key);
        const text = n === null ? undefined : stored.get(n);
        if (!n || !text) continue;
        texts.set(key, { number: n, title: text.title, body: text.body, ...memberState(db, key, text, listed.pulls.get(n)) });
      }
      // Wait for every member's text unless GitHub has none to give.
      const pending = ws.members.some((k) => !texts.has(k) && !unavailable.has(k));
      if (pending) continue;

      const request = buildWorkstreamSummaryRequest(ws, texts);
      const latest = latestSummary(db, "workstream", ws.id);
      if (summaryDecision(latest, request.inputHash, now) !== "queue") continue;
      const last = lastLlmJobFor(db, "workstream", ws.id, request.inputHash);
      // A failed input waits out the summary interval; bad keys, low credit and outages clear later.
      if (
        last?.status === "failed" &&
        last.finishedAt &&
        now.getTime() - Date.parse(last.finishedAt) < SUMMARY_MIN_INTERVAL_MS
      ) {
        continue;
      }

      const payload: StoredRequest = { ...request, model };
      const before = last?.status;
      enqueueLlmJob(
        db,
        { kind: "workstream", subjectKey: ws.id, inputHash: request.inputHash, requestJson: JSON.stringify(payload) },
        now.toISOString(),
      );
      if (before !== "queued" && before !== "running") queued++;
    }
    return queued;
  }

  async function runOne(ctx: JobContext, llm: LlmClient, job: LlmJobRecord): Promise<void> {
    const { db, config, clock, log } = ctx;
    const req = JSON.parse(job.requestJson) as StoredRequest;
    const prices = config.llm.prices;
    try {
      const result = await llm.complete({
        model: req.model,
        system: req.system,
        user: req.user,
        schema: OUTPUT_SCHEMAS[req.schemaName],
        maxTokens: SUMMARY_MAX_TOKENS,
      });
      const cost = costUsd(result.usage, req.model, prices) ?? 0;
      const finishedAt = clock().toISOString();
      const parsed = parseWorkstreamSummary(result.output);
      const error = "error" in parsed ? parsed.error : null;
      recordLlmCall(db, {
        jobId: job.id,
        kind: job.kind,
        model: result.model,
        usage: result.usage,
        costUsd: cost,
        durationMs: result.durationMs,
        ok: error === null,
        error,
        createdAt: finishedAt,
      });
      if ("error" in parsed) {
        retryOrFail(ctx, job, parsed.error, job.attempts < LLM_MAX_ATTEMPTS);
        return;
      }
      saveSummary(db, {
        kind: "workstream",
        subjectKey: job.subjectKey,
        inputHash: job.inputHash,
        promptVersion: req.promptVersion,
        model: result.model,
        name: parsed.name,
        text: parsed.summary,
        status: parsed.status ?? null,
        outputJson: JSON.stringify(parsed),
        costUsd: cost,
        createdAt: finishedAt,
      });
      appendChange(db, "workstream", job.subjectKey, finishedAt);
      completeLlmJob(db, job.id, finishedAt);
      log.info(`workstream summaries: summarized ${job.subjectKey} ($${cost.toFixed(4)})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const usage = err instanceof LlmError ? err.usage : null;
      recordLlmCall(db, {
        jobId: job.id,
        kind: job.kind,
        model: req.model,
        usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: usage ? (costUsd(usage, req.model, prices) ?? 0) : 0,
        durationMs: null,
        ok: false,
        error: message,
        createdAt: clock().toISOString(),
      });
      const retryable = err instanceof LlmError ? err.retryable : false;
      retryOrFail(ctx, job, message, retryable && job.attempts < LLM_MAX_ATTEMPTS);
    }
  }

  function retryOrFail(ctx: JobContext, job: LlmJobRecord, error: string, retry: boolean): void {
    const now = ctx.clock();
    const retryAt = retry ? new Date(now.getTime() + llmRetryDelayMs(job.attempts)).toISOString() : null;
    failLlmJob(ctx.db, job.id, error, now.toISOString(), retryAt);
    const what = retryAt ? `retrying at ${retryAt}` : "giving up";
    ctx.log.warn(`workstream summaries: ${job.subjectKey} failed (${error}); ${what}`);
  }

  async function runQueued(ctx: JobContext, llm: LlmClient): Promise<boolean> {
    const { db, config, clock, log } = ctx;
    const now = clock();
    requeueStaleLlmJobs(db, new Date(now.getTime() - STALE_RUNNING_MS).toISOString());
    const day = utcDayStart(now);
    const spent = llmSpendSince(db, day);
    if (spent >= config.llm.dailyCapUsd) {
      if (capLoggedFor !== day) {
        log.warn(`workstream summaries: daily LLM cap $${config.llm.dailyCapUsd} reached ($${spent.toFixed(2)}); waiting for tomorrow`);
        capLoggedFor = day;
      }
      return false;
    }
    const jobs = claimLlmJobs(db, now.toISOString(), LLM_CONCURRENCY);
    if (jobs.length === 0) return false;
    await Promise.all(jobs.map((job) => runOne(ctx, llm, job)));
    return true;
  }

  const llm = deps.llm;
  return {
    texts: {
      name: "workstreamTexts",
      async run(ctx) {
        const workstreams = loadShown(ctx.db);
        if (workstreams.length === 0) return "idle";
        return (await syncTexts(ctx, workstreams)) ? "worked" : "idle";
      },
    },
    summaries: llm && {
      name: "workstreamSummaries",
      ownTurn: true,
      async run(ctx) {
        const workstreams = loadShown(ctx.db);
        if (workstreams.length === 0) return "idle";
        queueSummaries(ctx, workstreams);
        return (await runQueued(ctx, llm)) ? "worked" : "idle";
      },
    },
  };
}
