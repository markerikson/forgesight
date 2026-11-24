import type { Database } from "bun:sqlite";
import type { Config } from "../core/config.ts";
import { META } from "../core/meta-keys.ts";
import type { Governor } from "../github/budget.ts";
import { GitHubApiError, RateLimitedError, TokenError } from "../github/errors.ts";
import type { GitHubClient } from "../github/types.ts";
import { setMeta } from "../store/meta.ts";

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
  run(ctx: JobContext): Promise<JobResult>;
}

/** `meta` key the web reads for worker health. */
export const WORKER_STATUS_KEY = META.workerStatus;
export type WorkerStatus = "running" | "auth_failed" | "stopped";

/** Minimum pause after any rate limit, primary or secondary. */
const RATE_LIMIT_MIN_PAUSE_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export type TickResult = "worked" | "idle" | "paused" | "stopped";

export interface SchedulerOptions {
  tickMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs jobs in priority order, one at a time. Each tick runs GitHub jobs until one reports
 * "worked", so higher-priority work goes first on the next tick, then runs every local job.
 * A job that throws is retried with backoff; a 401 stops the scheduler; a rate limit pauses
 * the GitHub jobs.
 */
export class Scheduler {
  private stopped = false;
  private running: Promise<TickResult> | null = null;
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  private readonly tickMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ctx: JobContext,
    private readonly jobs: Job[],
    opts: SchedulerOptions = {},
  ) {
    this.tickMs = opts.tickMs ?? 1000;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
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
    const remote = await this.runFirstWorking(this.jobs.filter((j) => !j.local));
    if (remote === "stopped") return "stopped";
    let localWorked = false;
    for (const job of this.jobs.filter((j) => j.local)) {
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
    const { db, governor, log, clock } = this.ctx;
    const now = clock();
    if (isAuthFailure(error, job.stopOn403 ?? false)) {
      log.error(`${job.name}: GitHub rejected the token, stopping the worker. ${errorMessage(error)}`);
      setMeta(db, WORKER_STATUS_KEY, "auth_failed", now.toISOString());
      this.stop();
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
    setMeta(this.ctx.db, WORKER_STATUS_KEY, "running", this.ctx.clock().toISOString());
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
