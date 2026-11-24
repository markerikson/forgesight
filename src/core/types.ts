// Shared domain types. Timestamps are ISO 8601 UTC strings, as GitHub returns them.
export type Login = string;

/** `owner/repo#N` for PRs and issues, `owner/repo@threadId` for other notification subjects. */
export type SubjectKey = string;

export type SubjectKind = "pr" | "issue" | "other";
export type SubjectOrigin = "thread" | "stack" | "open-list";
export type SubjectState = "OPEN" | "CLOSED" | "MERGED";

/** One GitHub notification thread. `raw` is the REST payload as received. */
export interface ThreadRecord {
  threadId: string;
  subjectKey: SubjectKey;
  repo: string;
  /** PullRequest | Issue | Release | Discussion | CheckSuite ... */
  subjectType: string;
  reason: string;
  unread: boolean;
  updatedAt: string;
  lastReadAt: string | null;
  firstSeenAt: string;
  /** Set when our outbox marked the thread done. */
  ghDoneAt: string | null;
  subjectUrl: string | null;
  raw: unknown;
}

/** What the poller supplies; the store owns `firstSeenAt` and `ghDoneAt`. */
export type ThreadUpsert = Omit<ThreadRecord, "firstSeenAt" | "ghDoneAt">;

/** A PR, issue, or other subject we track. `raw` is the last PrCore payload. */
export interface SubjectRecord {
  subjectKey: SubjectKey;
  repo: string;
  number: number | null;
  kind: SubjectKind;
  nodeId: string | null;
  origin: SubjectOrigin;
  state: SubjectState | null;
  author: Login | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  baseSha: string | null;
  updatedAt: string | null;
  timelineSyncedUntil: string | null;
  /** Non-null means the subject needs enrichment. */
  dirtyAt: string | null;
  priority: number;
  enrichError: string | null;
  enrichAttempts: number;
  raw: unknown;
}

export interface TimelineItemRecord {
  nodeId: string;
  subjectKey: SubjectKey;
  typename: string;
  createdAt: string;
  raw: unknown;
  fetchedAt: string;
}

export interface ReviewThreadRecord {
  nodeId: string;
  subjectKey: SubjectKey;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  raw: unknown;
  fetchedAt: string;
}

/** One distinct version of a sticky bot comment (DiffLoupe, replay-qa ...). */
export interface StickyCommentVersion {
  commentNodeId: string;
  /** sha256 hex of `body`. */
  bodyHash: string;
  subjectKey: SubjectKey;
  author: Login;
  lastEditedAt: string | null;
  /** When this body was first stored. */
  seenAt: string;
  /** The latest enrichment that saw this body; a comment's current body has the newest value. */
  lastSeenAt: string;
  body: string;
}

/** The result of enriching one subject, written in one transaction by the store. */
export interface EnrichmentResult {
  subjectKey: SubjectKey;
  subject: {
    nodeId: string | null;
    state: SubjectState | null;
    author: Login | null;
    headRef: string | null;
    baseRef: string | null;
    headSha: string | null;
    baseSha: string | null;
    updatedAt: string | null;
    raw: unknown;
  };
  /** New or already-stored items; items whose node id is stored are skipped. */
  timelineItems: Array<Pick<TimelineItemRecord, "nodeId" | "typename" | "createdAt" | "raw">>;
  /**
   * The subject's complete set of review threads, replacing the stored set.
   * Omit when review threads were not fetched (issues) to keep the stored set.
   */
  reviewThreads?: Array<Omit<ReviewThreadRecord, "subjectKey" | "fetchedAt">>;
  /** Current bodies of sticky comments; a body not stored yet becomes a new version. */
  stickies: Array<Pick<StickyCommentVersion, "commentNodeId" | "author" | "lastEditedAt" | "body">>;
  /**
   * Timeline cursor: when the query that fetched this result started, or null to leave unchanged.
   * The next fetch asks for items since a few minutes before it (see `timelineSince`).
   */
  timelineSyncedUntil: string | null;
}

/** User state for a subject. Web writes; the poller only seeds `dismissedAt` during backfill. */
export interface ItemState {
  dismissedAt: string | null;
  keepUnread: boolean;
  snoozeUntil: string | null;
  snoozeUntilHumanEvent: boolean;
  muted: boolean;
}

/** JSON object stored in a view column. Pipeline-v0 narrows these. */
export type ViewRow = Record<string, unknown>;
export type ViewDetail = Record<string, unknown>;

/** Derived, rebuildable list row and preview for one subject. */
export interface SubjectViewRecord {
  subjectKey: SubjectKey;
  pipelineVersion: number;
  configHash: string;
  /** waiting | updates | hidden, possibly snoozed; not constrained by the store. */
  section: string;
  sortAt: string;
  score: number;
  repo: string;
  stackId: string | null;
  row: ViewRow;
  detail: ViewDetail;
  computedAt: string;
}

/** `raw` feeds derive; `view`, `state`, `status` feed SSE. */
export type ChangeKind = "raw" | "view" | "state" | "status";
