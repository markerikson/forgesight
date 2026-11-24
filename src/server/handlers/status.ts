import { type ApiSpend, resourceSpendSince, spendSince } from "../../store/api-calls.ts";
import { type OutboxSummary, outboxSummary } from "../../store/state-ops.ts";
import type { ServerCtx } from "../ctx.ts";
import { type EnrichQueue, enrichQueue, readWorkerMeta } from "../queries.ts";

/** A heartbeat older than this means the worker has stopped. The worker writes one every 10s. */
export const HEARTBEAT_STALE_MS = 60_000;

export interface StatusPayload {
  now: string;
  worker: {
    status: string | null;
    heartbeatAt: string | null;
    /** null until the worker has written a heartbeat. */
    alive: boolean | null;
    authFailed: boolean;
  };
  viewer: { login: string | null };
  poll: {
    lastPollStartedAt: string | null;
    lastCheckAt: string | null;
    lastFullAt: string | null;
    nextPollAt: string | null;
  };
  backfill: { startedAt: string | null; completedAt: string | null; inProgress: boolean };
  enrichQueue: EnrichQueue;
  /** Last hour. `graphql` is summed point cost, `rest` is calls excluding 304s (the budget caps' units). */
  spend: { since: string; graphql: number; rest: number; byClass: ApiSpend[] };
  /** GitHub writes waiting to be sent, given up on, and the newest error among unsent rows. */
  outbox: OutboxSummary;
  configError: string | null;
}

export function readStatus(ctx: ServerCtx): StatusPayload {
  const now = ctx.now();
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const meta = readWorkerMeta(ctx.db);
  const heartbeat = meta.heartbeatAt ? Date.parse(meta.heartbeatAt) : Number.NaN;
  return {
    now: now.toISOString(),
    worker: {
      status: meta.status,
      heartbeatAt: meta.heartbeatAt,
      alive: Number.isNaN(heartbeat) ? null : now.getTime() - heartbeat < HEARTBEAT_STALE_MS,
      authFailed: meta.status === "auth_failed",
    },
    viewer: { login: meta.viewerLogin },
    poll: {
      lastPollStartedAt: meta.lastPollStartedAt,
      lastCheckAt: meta.lastCheckAt,
      lastFullAt: meta.lastFullAt,
      nextPollAt: meta.nextPollAt,
    },
    backfill: {
      startedAt: meta.backfillStartedAt,
      completedAt: meta.backfillCompletedAt,
      inProgress: meta.backfillStartedAt !== null && meta.backfillCompletedAt === null,
    },
    enrichQueue: enrichQueue(ctx.db),
    spend: {
      since,
      graphql: resourceSpendSince(ctx.db, "graphql", since),
      rest: resourceSpendSince(ctx.db, "rest", since),
      byClass: spendSince(ctx.db, since),
    },
    outbox: outboxSummary(ctx.db),
    configError: ctx.configError,
  };
}

export async function statusHandler(_req: Request, ctx: ServerCtx): Promise<Response> {
  return Response.json(readStatus(ctx));
}
