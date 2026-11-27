import type { Database } from "bun:sqlite";
import type { Config } from "../core/config.ts";
import { META } from "../core/meta-keys.ts";
import type { Governor } from "../github/budget.ts";
import { GitHubApiError, RateLimitedError, TokenError } from "../github/errors.ts";
import type { GitHubClient } from "../github/types.ts";
import { deleteMeta, setMeta } from "../store/meta.ts";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

export interface JobContext {
  db: Database;
  gh: GitHubClient;
  governor: Governor;
  config: Config;
  clock: () => Date;
  log: Logger;
}

export type JobResult = "worked" | "idle";

export interface Job {
  name: string;
  /**
   * Treat a plain 403 as a bad token and stop. Set for `/notifications` jobs, where a 403
   * without rate-limit headers means a token that cannot read notifications.
   */
  stopOn403?: boolean;
  /**
   * The job only touches the local database. It runs at the end of every tick, after the
   * GitHub jobs, even when one of them worked or GitHub calls are paused for a rate limit.
   */
  local?: boolean;
  /**
   * The job makes no GitHub calls, so it does not wait for GitHub work or the GitHub budget. It
   * runs every tick after the GitHub jobs, in list order with the local jobs.
   */
  ownTurn?: boolean;
  run(ctx: JobContext): Promise<JobResult>;
}

const everyTick = (job: Job) => job.local === true || job.ownTurn === true;

/** `meta` key the web reads for worker health. */
export const WORKER_STATUS_KEY = META.workerStatus;
export type WorkerStatus = "running" | "auth_failed" | "stopped";

/** Minimum pause after any rate limit, primary or secondary. */
const RATE_LIMIT_MIN_PAUSE_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** How long GitHub jobs wait after a rejected token before the worker tries the token again. */
export const AUTH_RETRY_MS = 5 * 60_000;

export type TickResult = "worked" | "idle" | "paused" | "auth_failed" | "stopped";

/** A fresh GitHub client and config, built from a re-read token. Throws `TokenError` on failure. */
export type Reconnect = () => Promise<Pick<JobContext, "gh" | "config">>;

export interface SchedulerOptions {
  tickMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called to retry the token after an auth failure. Without it the same client is retried. */
  reconnect?: Reconnect;
  /** Checked every tick during an auth failure; true retries the token right away. */
  credentialsChanged?: () => boolean;
}

/**
 * Runs jobs in priority order, one at a time. Each tick runs GitHub jobs until one reports
 * "worked", so higher-priority work goes first on the next tick, then runs every local and
 * own-turn job.
 * A job that throws is retried with backoff; a rate limit pauses the GitHub jobs. A rejected
 * token (401) holds every GitHub job, including the outbox, while local and own-turn jobs keep
 * running; the token is retried every `AUTH_RETRY_MS` or when `credentialsChanged` says so.
 */
export class Scheduler {
  private stopped = false;
  private running: Promise<TickResult> | null = null;
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  private authRetryAt: number | null = null;
  private readonly tickMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reconnect: Reconnect | undefined;
  private readonly credentialsChanged: (() => boolean) | undefined;

  constructor(
    private ctx: JobContext,
    private readonly jobs: Job[],
    opts: SchedulerOptions = {},
  ) {
    this.tickMs = opts.tickMs ?? 1000;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.reconnect = opts.reconnect;
    this.credentialsChanged = opts.credentialsChanged;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get authFailed(): boolean {
    return this.authRetryAt !== null;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Holds GitHub jobs until the token works again, and records why for the status bar. */
  markAuthFailed(message: string): void {
    const { db, clock, log } = this.ctx;
    const now = clock();
    this.authRetryAt = now.getTime() + AUTH_RETRY_MS;
    const nowIso = now.toISOString();
    setMeta(db, WORKER_STATUS_KEY, "auth_failed", nowIso);
    setMeta(db, META.authError, message, nowIso);
    setMeta(db, META.authRetryAt, new Date(this.authRetryAt).toISOString(), nowIso);
    log.error(
      `GitHub rejected the token; GitHub jobs are held, retrying at ${new Date(this.authRetryAt).toISOString()}. ${message}`,
    );
  }

  private clearAuthFailure(): void {
    const { db, clock, log } = this.ctx;
    this.authRetryAt = null;
    setMeta(db, WORKER_STATUS_KEY, "running", clock().toISOString());
    deleteMeta(db, META.authError);
    deleteMeta(db, META.authRetryAt);
    log.info("GitHub token accepted; GitHub jobs resume");
  }

  /** True when GitHub jobs may run this tick. */
  private async authReady(): Promise<boolean> {
    if (this.authRetryAt === null) return true;
    const due = this.ctx.clock().getTime() >= this.authRetryAt;
    if (!due && !(this.credentialsChanged?.() ?? false)) return false;
    if (!this.reconnect) {
      // Let the next GitHub call test the token; another 401 marks the failure again.
      this.clearAuthFailure();
      return true;
    }
    try {
      const next = await this.reconnect();
      this.ctx = { ...this.ctx, ...next };
      this.clearAuthFailure();
      return true;
    } catch (error) {
      // A network error while checking the token also waits for the next retry.
      this.markAuthFailed(errorMessage(error));
      return false;
    }
  }

  /** One pass over the jobs. Calls made while a tick is running wait for it and share its result. */
  tick(): Promise<TickResult> {
    if (this.running) return this.running;
    this.running = this.runTick().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runTick(): Promise<TickResult> {
    if (this.stopped) return "stopped";
    const remote = (await this.authReady())
      ? await this.runFirstWorking(this.jobs.filter((j) => !everyTick(j)))
      : "auth_failed";
    if (remote === "stopped") return "stopped";
    let localWorked = false;
    for (const job of this.jobs.filter(everyTick)) {
      if (this.retryPending(job)) continue;
      // oxlint-disable-next-line no-await-in-loop
      const result = await this.runJob(job);
      if (this.stopped) return "stopped";
      if (result === "worked") localWorked = true;
    }
    if (remote === "idle" && localWorked) return "worked";
    return remote;
  }

  private async runFirstWorking(jobs: Job[]): Promise<TickResult> {
    if (this.ctx.governor.pausedUntil()) return "paused";
    for (const job of jobs) {
      if (this.retryPending(job)) continue;
      // Jobs run strictly one after another; the loop must not overlap them.
      // oxlint-disable-next-line no-await-in-loop
      const result = await this.runJob(job);
      if (this.stopped) return "stopped";
      if (result === "failed") {
        if (this.authFailed) return "auth_failed";
        if (this.ctx.governor.pausedUntil()) return "paused";
        continue;
      }
      if (result === "worked") return "worked";
    }
    return "idle";
  }

  private retryPending(job: Job): boolean {
    const failure = this.failures.get(job.name);
    return failure !== undefined && this.ctx.clock().getTime() < failure.retryAt;
  }

  private async runJob(job: Job): Promise<JobResult | "failed"> {
    try {
      const result = await job.run(this.ctx);
      this.failures.delete(job.name);
      return result;
    } catch (error) {
      this.handleError(job, error);
      return "failed";
    }
  }

  private handleError(job: Job, error: unknown): void {
    const { governor, log, clock } = this.ctx;
    const now = clock();
    if (isAuthFailure(error, job.stopOn403 ?? false)) {
      this.markAuthFailed(`${job.name}: ${errorMessage(error)}`);
      return;
    }
    if (error instanceof RateLimitedError) {
      const until = new Date(
        Math.max(error.resetAt?.getTime() ?? 0, now.getTime() + RATE_LIMIT_MIN_PAUSE_MS),
      );
      governor.noteSecondaryLimit(until);
      log.warn(
        `${job.name}: ${error.secondary ? "secondary" : "primary"} rate limit, pausing until ${until.toISOString()}`,
      );
      return;
    }
    const count = (this.failures.get(job.name)?.count ?? 0) + 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (count - 1), RETRY_MAX_MS);
    this.failures.set(job.name, { count, retryAt: now.getTime() + delay });
    log.error(`${job.name} failed (attempt ${count}, retry in ${delay / 1000}s): ${errorMessage(error)}`);
  }

  /** Ticks until stopped: right away after work, after `tickMs` when idle or paused. */
  async run(): Promise<void> {
    if (!this.authFailed) {
      setMeta(this.ctx.db, WORKER_STATUS_KEY, "running", this.ctx.clock().toISOString());
      deleteMeta(this.ctx.db, META.authError);
      deleteMeta(this.ctx.db, META.authRetryAt);
    }
    while (!this.stopped) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await this.tick();
      // oxlint-disable-next-line no-await-in-loop
      if (result !== "worked" && !this.stopped) await this.sleep(this.tickMs);
    }
  }

  /**
   * Ticks until every job is idle, for `--once`. Returns early when stopped or paused,
   * and after a job keeps failing (`maxFailedTicks` ticks without progress).
   */
  async drain(maxFailedTicks = 3): Promise<TickResult> {
    let failedTicks = 0;
    while (true) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await this.tick();
      if (result !== "worked" && result !== "idle") return result;
      if (result === "worked") {
        failedTicks = 0;
        continue;
      }
      if (this.failures.size === 0) return "idle";
      failedTicks++;
      if (failedTicks >= maxFailedTicks) return "idle";
      const nextRetry = Math.min(...[...this.failures.values()].map((f) => f.retryAt));
      // oxlint-disable-next-line no-await-in-loop
      await this.sleep(Math.max(0, nextRetry - this.ctx.clock().getTime()));
    }
  }

  /** Job names with their consecutive failure count, for status reporting. */
  failingJobs(): Map<string, number> {
    return new Map([...this.failures].map(([name, f]) => [name, f.count]));
  }
}

function isAuthFailure(error: unknown, stopOn403: boolean): boolean {
  if (error instanceof TokenError) return true;
  return stopOn403 && error instanceof GitHubApiError && error.status === 403;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
