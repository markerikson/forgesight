import type { StickyCommentVersion, TimelineItemRecord } from "../types.ts";
import { bareLogin } from "./text.ts";
import { isAfter, ms } from "./time.ts";
import type { Actor, Event, EventData, EventKind, SubjectRef } from "./types.ts";

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** GraphQL `{ login, __typename }` or REST `{ login, type }` to an actor. */
export function toActor(value: unknown): Actor | null {
  const a = obj(value);
  const login = str(a?.login);
  if (!a || !login) return null;
  const isBot = a.__typename === "Bot" || a.type === "Bot" || login.endsWith("[bot]");
  return { login: bareLogin(login), isBot };
}

function loginOf(value: unknown): string | undefined {
  const a = obj(value);
  return str(a?.login) ?? str(a?.slug);
}

function subjectRef(value: unknown, fallbackRepo: string): SubjectRef | undefined {
  const s = obj(value);
  const number = s?.number;
  if (!s || typeof number !== "number") return undefined;
  const ref: SubjectRef = {
    kind: s.__typename === "PullRequest" ? "pr" : "issue",
    repo: str(obj(s.repository)?.nameWithOwner) ?? fallbackRepo,
    number,
  };
  const title = str(s.title);
  if (title !== undefined) ref.title = title;
  const state = str(s.state);
  if (state !== undefined) ref.state = state;
  return ref;
}

/** Event fields before `undefined` values are dropped. */
type LooseData = { [K in Exclude<keyof EventData, "typename">]?: EventData[K] | undefined };

interface MappedItem {
  kind: EventKind;
  actor?: Actor | null;
  at?: string | undefined;
  body?: string;
  data?: LooseData;
}

function mapItem(typename: string, raw: Raw, repo: string): MappedItem {
  const actor = toActor(raw.actor);
  switch (typename) {
    case "IssueComment":
      return {
        kind: "comment",
        actor: toActor(raw.author),
        body: str(raw.body) ?? "",
        data: { ...(str(raw.url) ? { url: str(raw.url) } : {}) },
      };
    case "DiscussionComment":
      return {
        kind: "comment",
        actor: toActor(raw.author),
        body: str(raw.body) ?? "",
        data: { url: str(raw.url), replyTo: str(obj(raw.replyTo)?.id) },
      };
    case "DiscussionAnswer":
      return { kind: "answered", actor, data: { target: str(raw.commentId) } };
    case "DiscussionClosed":
      return { kind: "closed", actor: null, data: {} };
    case "PullRequestReview": {
      const comments = (obj(raw.comments)?.nodes as unknown[] | undefined) ?? [];
      const first = obj(comments[0]);
      const data: LooseData = { reviewState: str(raw.state) ?? "COMMENTED" };
      if (comments.length > 0) data.commentCount = comments.length;
      if (first) data.firstComment = { path: str(first.path) ?? null, body: str(first.body) ?? "" };
      const url = str(raw.url);
      if (url) data.url = url;
      return {
        kind: "review",
        actor: toActor(raw.author),
        at: str(raw.submittedAt) ?? str(raw.createdAt),
        body: str(raw.body) ?? "",
        data,
      };
    }
    case "PullRequestCommit": {
      const commit = obj(raw.commit);
      const user = obj(obj(commit?.author)?.user);
      return {
        kind: "commit",
        actor: user && str(user.login) ? { login: bareLogin(str(user.login) ?? ""), isBot: false } : null,
        data: { sha: str(commit?.oid), headline: str(commit?.messageHeadline) },
      };
    }
    case "HeadRefForcePushedEvent":
    case "BaseRefForcePushedEvent":
      return {
        kind: typename === "HeadRefForcePushedEvent" ? "forcePush" : "baseForcePush",
        actor,
        data: { beforeSha: str(obj(raw.beforeCommit)?.oid), afterSha: str(obj(raw.afterCommit)?.oid) },
      };
    case "MergedEvent":
      return { kind: "merged", actor, data: { sha: str(obj(raw.commit)?.oid) } };
    case "ClosedEvent": {
      const closer = obj(raw.closer);
      if (closer?.__typename === "PullRequest") {
        return { kind: "closedByPr", actor, data: { ref: subjectRef(closer, repo) } };
      }
      return { kind: "closed", actor, data: {} };
    }
    case "ReopenedEvent":
      return { kind: "reopened", actor };
    case "ReadyForReviewEvent":
      return { kind: "readyForReview", actor };
    case "ConvertToDraftEvent":
      return { kind: "convertToDraft", actor };
    case "ReviewRequestedEvent":
      return { kind: "reviewRequested", actor, data: { target: loginOf(raw.requestedReviewer) } };
    case "ReviewRequestRemovedEvent":
      return { kind: "reviewRequestRemoved", actor, data: { target: loginOf(raw.requestedReviewer) } };
    case "ReviewDismissedEvent":
      return { kind: "reviewDismissed", actor, data: { reviewState: str(raw.previousReviewState) } };
    case "CrossReferencedEvent":
      return {
        kind: "crossReference",
        actor,
        data: { ref: subjectRef(raw.source, repo), willClose: raw.willCloseTarget === true },
      };
    case "ReferencedEvent": {
      const commit = obj(raw.commit);
      return { kind: "reference", actor, data: { sha: str(commit?.oid), headline: str(commit?.messageHeadline) } };
    }
    case "RenamedTitleEvent":
      return { kind: "renamed", actor, data: { from: str(raw.previousTitle), to: str(raw.currentTitle) } };
    case "BaseRefChangedEvent":
      return { kind: "baseChanged", actor, data: { from: str(raw.previousRefName), to: str(raw.currentRefName) } };
    case "AutomaticBaseChangeSucceededEvent":
      return { kind: "baseChanged", actor, data: { from: str(raw.oldBase), to: str(raw.newBase) } };
    case "LabeledEvent":
    case "UnlabeledEvent":
      return {
        kind: "labeled",
        actor,
        data: { label: str(obj(raw.label)?.name), added: typename === "LabeledEvent" },
      };
    case "AssignedEvent":
    case "UnassignedEvent":
      return {
        kind: "assigned",
        actor,
        data: { target: loginOf(raw.assignee), added: typename === "AssignedEvent" },
      };
    case "MentionedEvent":
      // GitHub sets the actor of a mention event to the user who was mentioned.
      return { kind: "mentioned", actor, data: { target: actor?.login } };
    case "AddedToStackEvent":
    case "RemovedFromStackEvent":
      return { kind: "stack", actor, data: { added: typename === "AddedToStackEvent" } };
    case "ConnectedEvent":
    case "DisconnectedEvent":
      return {
        kind: "connected",
        actor,
        data: { ref: subjectRef(raw.source, repo), added: typename === "ConnectedEvent" },
      };
    case "MarkedAsDuplicateEvent":
      return { kind: "markedDuplicate", actor, data: { ref: subjectRef(raw.canonical, repo) } };
    case "TransferredEvent":
      return { kind: "transferred", actor, data: { from: str(obj(raw.fromRepository)?.nameWithOwner) } };
    case "SubIssueAddedEvent":
    case "SubIssueRemovedEvent":
      return {
        kind: "subIssue",
        actor,
        data: { ref: subjectRef(raw.subIssue, repo), added: typename === "SubIssueAddedEvent" },
      };
    case "ParentIssueAddedEvent":
    case "ParentIssueRemovedEvent":
      return {
        kind: "subIssue",
        actor,
        data: { ref: subjectRef(raw.parent, repo), added: typename === "ParentIssueAddedEvent" },
      };
    case "MilestonedEvent":
    case "DemilestonedEvent":
      return {
        kind: "milestoned",
        actor,
        data: { milestone: str(raw.milestoneTitle), added: typename === "MilestonedEvent" },
      };
    default:
      return { kind: "unknown", actor };
  }
}

/**
 * Timeline item types that say nothing a reader needs: subscriptions, branch deletion after
 * merge, deployments, project board moves. They are dropped before classification, so they
 * never show, count as hidden, or count as new activity.
 */
const NOISE_TYPENAMES: ReadonlySet<string> = new Set([
  "SubscribedEvent",
  "UnsubscribedEvent",
  "HeadRefDeletedEvent",
  "HeadRefRestoredEvent",
  "DeployedEvent",
  "DeploymentEnvironmentChangedEvent",
  "CommentDeletedEvent",
  "AddedToProjectEvent",
  "AddedToProjectV2Event",
  "MovedColumnsInProjectEvent",
  "RemovedFromProjectEvent",
  "RemovedFromProjectV2Event",
  "ProjectV2ItemStatusChangedEvent",
  "ConvertedNoteToIssueEvent",
  "ConvertedFromDraftEvent",
  "UserBlockedEvent",
  "PullRequestRevisionMarker",
]);

function withoutUndefined(data: LooseData & { typename: string }): EventData {
  const out: Raw = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = v;
  return out as unknown as EventData;
}

function latestVersion(versions: StickyCommentVersion[]): StickyCommentVersion | undefined {
  let latest: StickyCommentVersion | undefined;
  for (const v of versions) {
    if (
      !latest ||
      isAfter(v.lastSeenAt, latest.lastSeenAt) ||
      (v.lastSeenAt === latest.lastSeenAt && isAfter(v.seenAt, latest.seenAt))
    ) {
      latest = v;
    }
  }
  return latest;
}

/** The raw node carries its own time; otherwise the stored time is the fetch time. */
function hasTimestamp(raw: Record<string, unknown>): boolean {
  return str(raw.createdAt) !== undefined || str(obj(raw.commit)?.committedDate) !== undefined;
}

function compareEvents(a: Event, b: Event): number {
  const diff = ms(a.at) - ms(b.at);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Stored timeline items and sticky comment versions to events, oldest first. A sticky comment
 * takes its newest stored body and its last edit time, so an edited sticky reads as new
 * activity. Stickies whose original comment is outside the stored timeline become comments.
 */
export function normalize(input: {
  repo: string;
  items: TimelineItemRecord[];
  stickies: StickyCommentVersion[];
}): Event[] {
  const byComment = new Map<string, StickyCommentVersion[]>();
  for (const s of input.stickies) {
    const list = byComment.get(s.commentNodeId) ?? [];
    list.push(s);
    byComment.set(s.commentNodeId, list);
  }

  const events: Event[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.nodeId) || NOISE_TYPENAMES.has(item.typename)) continue;
    seen.add(item.nodeId);
    const raw = obj(item.raw) ?? {};
    const p = mapItem(item.typename, raw, input.repo);
    const event: Event = {
      id: item.nodeId,
      at: p.at ?? item.createdAt,
      actor: p.actor ?? null,
      kind: p.kind,
      data: withoutUndefined({ typename: item.typename, ...p.data }),
    };
    if (p.body !== undefined) event.body = p.body;
    if (p.at === undefined && !hasTimestamp(raw)) event.undated = true;
    events.push(event);
  }

  for (const [commentId, versions] of byComment) {
    const latest = latestVersion(versions);
    if (!latest) continue;
    const editedAt = latest.lastEditedAt ?? latest.seenAt;
    const existing = events.find((e) => e.id === commentId);
    if (existing) {
      if (existing.body !== latest.body) {
        existing.body = latest.body;
        existing.data = { ...existing.data, edited: true };
        if (isAfter(editedAt, existing.at)) existing.at = editedAt;
      }
      continue;
    }
    events.push({
      id: commentId,
      at: editedAt,
      actor: { login: bareLogin(latest.author), isBot: true },
      kind: "comment",
      body: latest.body,
      data: { typename: "IssueComment", edited: versions.length > 1 },
    });
  }

  return events.sort(compareEvents);
}
