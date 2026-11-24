import type { Database } from "bun:sqlite";
import type { ApiCallLog } from "../github/budget.ts";
import type { ApiCallRecord, Resource } from "../github/types.ts";
import { recordApiCall, resourceSpendSince } from "../store/api-calls.ts";

/** `ApiCallLog` over the `api_calls` table, so the budget survives restarts. */
export class SqliteApiCallLog implements ApiCallLog {
  constructor(private readonly db: Database) {}

  append(call: ApiCallRecord): void {
    recordApiCall(this.db, {
      at: call.at.toISOString(),
      resource: call.resource,
      workClass: call.workClass,
      request: call.request,
      status: call.status,
      cost: call.cost,
      remaining: call.remaining,
      resetAt: call.resetAt?.toISOString() ?? null,
      durationMs: call.durationMs,
    });
  }

  spendSince(resource: Resource, since: Date): number {
    return resourceSpendSince(this.db, resource, since.toISOString());
  }
}
