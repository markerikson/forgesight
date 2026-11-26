import type { Resource, WorkClass } from "../core/budget.ts";

export type { Resource, WorkClass };

/** One notification thread, flattened from the REST payload. */
export interface NotificationThread {
  id: string;
  /** `owner/name` */
  repo: string;
  /** PullRequest | Issue | Release | Discussion | CheckSuite ... */
  subjectType: string;
  subjectUrl: string | null;
  subjectTitle: string;
  reason: string;
  unread: boolean;
  updatedAt: string;
  lastReadAt: string | null;
  /** The REST notification object as received. */
  raw: unknown;
}

export type PollResult =
  | { kind: "notModified"; nextPollAt: Date }
  | { kind: "changed"; etag: string; nextPollAt: Date; threads: NotificationThread[] };

export interface PollOptions {
  /** ETag of the last changed response. */
  etag?: string;
  /** Skip the in-process poll-interval wait, for the first poll after a restart. */
  force?: boolean;
}

export interface GqlOpts {
  /** `owner/name`, recorded with the call. */
  repo: string;
  workClass: WorkClass;
  /** Per-attempt timeout. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** One entry of a GraphQL `errors` array. */
export interface GqlErrorEntry {
  message: string;
  type?: string;
  path?: Array<string | number>;
}

export interface GqlResult<T> {
  /** `data` with the `rateLimit` field removed. Fields that failed are null. */
  data: T;
  cost: number;
  remaining: number;
  resetAt: Date;
  /** Present when GitHub returned partial data. NOT_FOUND on an alias lands here. */
  errors?: GqlErrorEntry[];
  /** How many attempts failed with a 502 before this one succeeded. Large queries should shrink. */
  gatewayErrors: number;
}

export interface CommitFile {
  /** Blob SHA of the file after the change; null for a deleted file. */
  sha: string | null;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  previousFilename: string | null;
}

export interface CommitDetail {
  sha: string;
  parents: string[];
  treeSha: string;
  message: string;
  files: CommitFile[];
  raw: unknown;
}

export interface Compare {
  status: "ahead" | "behind" | "diverged" | "identical";
  aheadBy: number;
  behindBy: number;
  mergeBaseSha: string;
  commitShas: string[];
  /** All commits in the range. `commitShas` stops at 250. */
  totalCommits: number;
  /** At most 300 files; GitHub drops the rest. */
  files: CommitFile[];
  raw: unknown;
}

/** One HTTP request to GitHub, as stored in `api_calls`. */
export interface ApiCallRecord {
  at: Date;
  resource: Resource;
  workClass: WorkClass;
  /** Method and path, or `graphql <repo>`. */
  request: string;
  /** HTTP status; 0 for a network failure or timeout. */
  status: number;
  /** GraphQL `rateLimit.cost`; null for REST. */
  cost: number | null;
  remaining: number | null;
  resetAt: Date | null;
  durationMs: number;
}

export interface GitHubClient {
  pollNotifications(opts: PollOptions): Promise<PollResult>;
  /** Pages of threads updated since `since`, newest first. */
  listNotificationsSince(since: Date): AsyncIterable<NotificationThread[]>;
  /** Backfill: pages from newest, stopping at the first thread older than `cutoff`. */
  listNotificationsBefore(cutoff: Date): AsyncIterable<NotificationThread[]>;
  markDone(threadId: string): Promise<void>;
  markRead(threadId: string): Promise<void>;
  unsubscribe(threadId: string): Promise<void>;
  resubscribe(threadId: string): Promise<void>;
  graphql<T>(query: string, variables: Record<string, unknown>, opts: GqlOpts): Promise<GqlResult<T>>;
  getCommit(repo: string, sha: string): Promise<CommitDetail>;
  compare(repo: string, base: string, head: string): Promise<Compare>;
  viewerLogin(): Promise<string>;
}
