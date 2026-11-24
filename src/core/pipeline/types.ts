// View types produced by the derive pipeline. Everything here is plain JSON so it can be
// stored in `subject_views` and sent to the web client unchanged.
import type { ContentLevel } from "../config.ts";
import type { SubjectKey, SubjectKind, SubjectState } from "../types.ts";

/** Inbox section. `snoozed` overrides the other three while a snooze is active. */
export type Section = "waiting" | "updates" | "hidden" | "snoozed";

export type Level = ContentLevel;

export type BotKind = "review" | "ci" | "preview" | "status" | "dependency" | "discussion";

export interface Actor {
  /** Login without a trailing `[bot]`. */
  login: string;
  isBot: boolean;
}

export type EventKind =
  | "comment"
  | "review"
  | "reviewComment"
  | "commit"
  | "forcePush"
  | "baseForcePush"
  | "merged"
  | "closed"
  | "reopened"
  | "readyForReview"
  | "convertToDraft"
  | "reviewRequested"
  | "reviewRequestRemoved"
  | "reviewDismissed"
  | "crossReference"
  | "reference"
  | "renamed"
  | "baseChanged"
  | "labeled"
  | "assigned"
  | "mentioned"
  | "stack"
  | "connected"
  | "closedByPr"
  | "markedDuplicate"
  | "transferred"
  | "subIssue"
  | "unknown";

/** A PR or issue another event points at. */
export interface SubjectRef {
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title?: string;
  state?: string;
}

/** Per-kind event fields. Only the fields that apply to an event's kind are set. */
export interface EventData {
  /** GraphQL `__typename` of the stored item. */
  typename: string;
  /** Comment or review URL on GitHub. */
  url?: string;
  /** Review: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING. */
  reviewState?: string;
  /** Review: number of inline comments, and the first one's path and body. */
  commentCount?: number;
  firstComment?: { path: string | null; body: string };
  /** Commit and merge: commit SHA. Commit: headline. */
  sha?: string;
  headline?: string;
  /** Force-pushes. */
  beforeSha?: string;
  afterSha?: string;
  /** Review requests, assignments, mentions: the user or team the event is about. */
  target?: string;
  /** Labels. */
  label?: string;
  /** `false` for unlabeled, unassigned, disconnected. */
  added?: boolean;
  /** Renames and base changes. */
  from?: string;
  to?: string;
  /** Cross-references, connections, closers, duplicates. */
  ref?: SubjectRef;
  willClose?: boolean;
  /** Sticky comments: the body was edited after it was posted. */
  edited?: boolean;
}

export interface Event {
  /** Timeline node id. */
  id: string;
  /** ISO 8601. */
  at: string;
  /** GitHub gave no timestamp; `at` is the fetch time. Such events are never new. */
  undated?: true;
  actor: Actor | null;
  kind: EventKind;
  /** Markdown body for comments and reviews. */
  body?: string;
  data: EventData;
}

export interface Extracted {
  url?: string;
  prRefs?: string[];
  sha?: string;
}

/** An event with its display level. This is what the preview pane renders. */
export interface ViewEvent extends Event {
  level: Level;
  /** Id of the bot or content rule that decided the level. */
  ruleId?: string;
  botKind?: BotKind;
  extracted?: Extracted;
  /** After `state.dismissedAt` (or no dismissedAt yet). */
  isNew: boolean;
}

/** A run of collapsed events shown as one line, e.g. "3 bot comments, 2 cross-references". */
export interface CollapsedGroup {
  summary: string;
  items: ViewEvent[];
  isNew: boolean;
}

/** One line in a round, oldest first: a shown event or a collapsed group. */
export type RoundEntry =
  | { type: "event"; event: ViewEvent }
  | { type: "group"; group: CollapsedGroup };

export interface Round {
  /** The push or commit batch that opened the round; null for the first stored round. */
  startedBy: ViewEvent | null;
  /**
   * "force-pushed", "pushed 3 commits", "5 pushes, no other activity" for merged push-only
   * rounds, or null for the first round.
   */
  startLabel: string | null;
  startedAt: string;
  /** Pushes (force-pushes and commit batches) in this round: 0 for the first round, more than 1 when push-only rounds were merged. */
  pushCount: number;
  /** Commits in the pushes that opened the round, oldest first; empty for force-pushes. */
  commits: ViewEvent[];
  /** Shown events and collapsed groups in time order, oldest first. */
  entries: RoundEntry[];
  hiddenCount: number;
  isNew: boolean;
}

export type CiState = "success" | "failure" | "pending" | "error" | "expected";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export interface SubjectHeader {
  key: SubjectKey;
  repo: string;
  number: number | null;
  kind: SubjectKind;
  title: string;
  url: string | null;
  author: string | null;
  authorIsBot: boolean;
  state: SubjectState | null;
  draft: boolean;
  merged: boolean;
  headRef: string | null;
  baseRef: string | null;
  ciState: CiState | null;
  reviewDecision: ReviewDecision | null;
  /** Login of the newest human actor in the stored timeline. */
  latestHumanActor: string | null;
  labels: string[];
  /** Last enrichment error, shown as a stale-data badge. */
  enrichError: string | null;
}

export type RankReason =
  | "reviewRequested"
  | "mentioned"
  | "assigned"
  | "onMyPr"
  | "onMyReview"
  | "participating"
  | "newActivity"
  | "stateChange"
  | "newIssue"
  | "snoozed"
  | "muted"
  | "notEnriched"
  | "closedByOthers"
  | "nothingNew";

/** Counts the inbox sums into per-repo lines like "backend: 38 PRs pushed, 12 merged". */
export interface HiddenStats {
  pushes: number;
  merged: number;
  closed: number;
}

export interface ViewLink {
  label: string;
  url: string;
}

export interface SubjectView {
  key: SubjectKey;
  header: SubjectHeader;
  /** Newest first. */
  rounds: Round[];
  lastVisitAt: string | null;
  links: ViewLink[];
  section: Section;
  reasons: RankReason[];
  score: number;
  newMeaningfulCount: number;
  summaryLine: string;
  hiddenStats: HiddenStats;
  sortAt: string;
  snoozeUntil: string | null;
  unread: boolean;
}

/** Placeholder for findings badges (M5). */
export interface FindingIcon {
  kind: string;
  count: number;
}

/** Compact list row for the inbox. */
export interface InboxRow {
  key: SubjectKey;
  repo: string;
  number: number | null;
  kind: SubjectKind;
  title: string;
  url: string | null;
  author: string | null;
  state: SubjectState | null;
  draft: boolean;
  merged: boolean;
  ciState: CiState | null;
  reviewDecision: ReviewDecision | null;
  latestActor: string | null;
  section: Section;
  reasons: RankReason[];
  summaryLine: string;
  newMeaningfulCount: number;
  hiddenStats: HiddenStats;
  sortAt: string;
  snoozeUntil: string | null;
  unread: boolean;
  enrichError: string | null;
  findings: FindingIcon[];
}
