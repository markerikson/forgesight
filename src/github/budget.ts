import { decideAllowed, type RemainingQuota } from "../core/budget.ts";
import type { ApiCallRecord, Resource, WorkClass } from "./types.ts";

const HOUR_MS = 60 * 60 * 1000;

/** Where API calls are kept. The store provides the `api_calls`-backed one. */
export interface ApiCallLog {
  append(call: ApiCallRecord): void;
  /** GraphQL: sum of cost. REST: request count, excluding 304s. */
  spendSince(resource: Resource, since: Date): number;
}

export class MemoryApiCallLog implements ApiCallLog {
  readonly calls: ApiCallRecord[] = [];

  append(call: ApiCallRecord): void {
    this.calls.push(call);
  }

  spendSince(resource: Resource, since: Date): number {
    let spend = 0;
    for (const call of this.calls) {
      if (call.resource !== resource || call.at < since) continue;
      spend += callSpend(call);
    }
    return spend;
  }
}

/** What one call counts against our hourly cap. */
export function callSpend(call: ApiCallRecord): number {
  if (call.resource === "graphql") return call.cost ?? 0;
  return call.status === 304 ? 0 : 1;
}

export interface BudgetCaps {
  graphqlPerHour: number;
  restPerHour: number;
}

/** Decides which work classes may spend, from logged calls, GitHub's counters and rate-limit pauses. */
export class Governor {
  private readonly remaining: Partial<Record<Resource, RemainingQuota>> = {};
  private paused: Date | null = null;

  constructor(
    private readonly log: ApiCallLog,
    private readonly caps: BudgetCaps,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  canSpend(resource: Resource, workClass: WorkClass): boolean {
    return this.allowed(resource).has(workClass);
  }

  allowed(resource: Resource): Set<WorkClass> {
    const now = this.clock();
    return decideAllowed(
      {
        spend: this.log.spendSince(resource, new Date(now.getTime() - HOUR_MS)),
        cap: resource === "graphql" ? this.caps.graphqlPerHour : this.caps.restPerHour,
        remaining: this.remaining[resource] ?? null,
        pausedUntil: this.paused,
      },
      now,
    );
  }

  record(call: ApiCallRecord): void {
    this.log.append(call);
    if (call.remaining !== null && call.resetAt !== null) {
      this.noteRemaining(call.resource, call.remaining, call.resetAt);
    }
  }

  noteRemaining(resource: Resource, remaining: number, resetAt: Date): void {
    this.remaining[resource] = { remaining, resetAt };
  }

  /** A secondary limit stops all work, on both resources, until `until`. */
  noteSecondaryLimit(until: Date): void {
    if (!this.paused || until > this.paused) this.paused = until;
  }

  pausedUntil(): Date | null {
    if (this.paused && this.clock() >= this.paused) this.paused = null;
    return this.paused;
  }
}
