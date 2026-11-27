import { NotFoundError } from "./errors.ts";
import type {
  CommitDetail,
  Compare,
  GitHubClient,
  GqlOpts,
  GqlResult,
  NotificationThread,
  PollOptions,
  PollResult,
} from "./types.ts";

export type FakeCall =
  | { method: "pollNotifications"; opts: PollOptions }
  | { method: "listNotificationsSince"; since: Date }
  | { method: "listNotificationsBefore"; cutoff: Date }
  | { method: "listNotificationsByDone"; done: boolean; since: Date }
  | { method: "markDone" | "markRead" | "unsubscribe" | "resubscribe"; threadId: string }
  | { method: "graphql"; query: string; variables: Record<string, unknown>; opts: GqlOpts }
  | { method: "getCommit"; repo: string; sha: string }
  | { method: "compare"; repo: string; base: string; head: string }
  | { method: "viewerLogin" };

export type GraphqlHandler = (
  query: string,
  variables: Record<string, unknown>,
  opts: GqlOpts,
) => Promise<GqlResult<unknown>> | GqlResult<unknown>;

/** In-memory GitHub for poller and scheduler tests. Threads are served newest first. */
export class FakeGitHubClient implements GitHubClient {
  readonly calls: FakeCall[] = [];
  readonly threads = new Map<string, NotificationThread>();
  readonly done = new Set<string>();
  readonly unsubscribed = new Set<string>();
  readonly commits = new Map<string, CommitDetail>();
  readonly compares = new Map<string, Compare>();
  graphqlHandler: GraphqlHandler | null = null;
  login = "octocat";
  pageSize = 50;
  pollIntervalMs = 60_000;
  /** Thrown by the next call to any method, then cleared. */
  nextError: Error | null = null;

  private version = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Adds or replaces threads and changes the feed's ETag. */
  setThreads(...threads: NotificationThread[]): void {
    for (const thread of threads) {
      this.threads.set(thread.id, thread);
      this.done.delete(thread.id);
    }
    this.version++;
  }

  get etag(): string {
    return `"fake-${this.version}"`;
  }

  private takeError(): void {
    const error = this.nextError;
    if (error) {
      this.nextError = null;
      throw error;
    }
  }

  /** Like GitHub's `all=true` listings, this includes threads marked done. */
  private sorted(): NotificationThread[] {
    return [...this.threads.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private pages(threads: NotificationThread[]): NotificationThread[][] {
    const pages: NotificationThread[][] = [];
    for (let i = 0; i < threads.length; i += this.pageSize) pages.push(threads.slice(i, i + this.pageSize));
    return pages;
  }

  async pollNotifications(opts: PollOptions): Promise<PollResult> {
    this.calls.push({ method: "pollNotifications", opts });
    this.takeError();
    const nextPollAt = new Date(this.clock().getTime() + this.pollIntervalMs);
    if (opts.etag === this.etag) return { kind: "notModified", nextPollAt };
    return { kind: "changed", etag: this.etag, nextPollAt, threads: this.sorted().slice(0, this.pageSize) };
  }

  async *listNotificationsSince(since: Date): AsyncIterable<NotificationThread[]> {
    this.calls.push({ method: "listNotificationsSince", since });
    this.takeError();
    const threads = this.sorted().filter((t) => Date.parse(t.updatedAt) >= since.getTime());
    yield* this.pages(threads);
  }

  async *listNotificationsBefore(cutoff: Date): AsyncIterable<NotificationThread[]> {
    this.calls.push({ method: "listNotificationsBefore", cutoff });
    this.takeError();
    const threads = this.sorted().filter((t) => Date.parse(t.updatedAt) >= cutoff.getTime());
    yield* this.pages(threads);
  }

  async *listNotificationsByDone(done: boolean, since: Date): AsyncIterable<NotificationThread[]> {
    this.calls.push({ method: "listNotificationsByDone", done, since });
    this.takeError();
    const threads = this.sorted().filter(
      (t) => this.done.has(t.id) === done && Date.parse(t.updatedAt) >= since.getTime(),
    );
    yield* this.pages(threads);
  }

  async markDone(threadId: string): Promise<void> {
    this.calls.push({ method: "markDone", threadId });
    this.takeError();
    this.done.add(threadId);
    this.version++;
  }

  async markRead(threadId: string): Promise<void> {
    this.calls.push({ method: "markRead", threadId });
    this.takeError();
    const thread = this.threads.get(threadId);
    if (thread) this.threads.set(threadId, { ...thread, unread: false });
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.calls.push({ method: "unsubscribe", threadId });
    this.takeError();
    this.unsubscribed.add(threadId);
  }

  async resubscribe(threadId: string): Promise<void> {
    this.calls.push({ method: "resubscribe", threadId });
    this.takeError();
    this.unsubscribed.delete(threadId);
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, opts: GqlOpts): Promise<GqlResult<T>> {
    this.calls.push({ method: "graphql", query, variables, opts });
    this.takeError();
    if (!this.graphqlHandler) throw new Error("FakeGitHubClient: no graphqlHandler set");
    return (await this.graphqlHandler(query, variables, opts)) as GqlResult<T>;
  }

  async getCommit(repo: string, sha: string): Promise<CommitDetail> {
    this.calls.push({ method: "getCommit", repo, sha });
    this.takeError();
    const commit = this.commits.get(`${repo}@${sha}`);
    if (!commit) throw new NotFoundError(`get commit ${repo}@${sha}: not found`);
    return commit;
  }

  async compare(repo: string, base: string, head: string): Promise<Compare> {
    this.calls.push({ method: "compare", repo, base, head });
    this.takeError();
    const result = this.compares.get(`${repo}:${base}...${head}`);
    if (!result) throw new NotFoundError(`compare ${repo} ${base}...${head}: not found`);
    return result;
  }

  async viewerLogin(): Promise<string> {
    this.calls.push({ method: "viewerLogin" });
    this.takeError();
    return this.login;
  }
}

/** A thread with sensible defaults, for tests. */
export function fakeThread(overrides: Partial<NotificationThread> & { id: string }): NotificationThread {
  return {
    repo: "octo/repo",
    subjectType: "PullRequest",
    subjectUrl: `https://api.github.com/repos/octo/repo/pulls/${overrides.id}`,
    subjectTitle: `Thread ${overrides.id}`,
    reason: "subscribed",
    unread: true,
    updatedAt: "2026-11-23T12:00:00Z",
    lastReadAt: null,
    raw: {},
    ...overrides,
  };
}
