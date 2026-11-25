import { typenameLabel, type Event, type SubjectRef } from "../core/index.ts";

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

export function refText(ref: SubjectRef | undefined): string {
  if (!ref) return "another item";
  const title = ref.title ? ` ${ref.title}` : "";
  return `${ref.repo}#${ref.number}${title}`;
}

const REVIEW_VERBS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "reviewed",
  DISMISSED: "left a dismissed review",
  PENDING: "started a review",
};

/** The action part of an event line, without the actor: "approved", "pushed 1a2b3c4 Fix tests". */
export function describeEvent(event: Event): string {
  const d = event.data;
  const target = d.target ?? "someone";
  switch (event.kind) {
    case "comment":
      return d.edited ? "commented (edited)" : "commented";
    case "review": {
      const verb = REVIEW_VERBS[d.reviewState ?? ""] ?? "reviewed";
      const count = d.commentCount ?? 0;
      return count > 0 ? `${verb} with ${count} comment${count === 1 ? "" : "s"}` : verb;
    }
    case "reviewComment":
      return d.firstComment?.path ? `commented on ${d.firstComment.path}` : "left a review comment";
    case "commit":
      return `pushed ${shortSha(d.sha)}${d.headline ? ` ${d.headline}` : ""}`;
    case "forcePush":
      return `force-pushed ${shortSha(d.beforeSha)} → ${shortSha(d.afterSha)}`;
    case "baseForcePush":
      return `force-pushed the base ${shortSha(d.beforeSha)} → ${shortSha(d.afterSha)}`;
    case "merged":
      return d.sha ? `merged ${shortSha(d.sha)}` : "merged";
    case "closed":
      return "closed";
    case "reopened":
      return "reopened";
    case "readyForReview":
      return "marked ready for review";
    case "convertToDraft":
      return "converted to draft";
    case "reviewRequested":
      return `requested review from ${target}`;
    case "reviewRequestRemoved":
      return `removed the review request for ${target}`;
    case "reviewDismissed":
      return "dismissed a review";
    case "crossReference":
      return `${d.willClose ? "will close this from" : "referenced this from"} ${refText(d.ref)}`;
    case "reference":
      return d.sha ? `referenced this in ${shortSha(d.sha)}` : "referenced this in a commit";
    case "renamed":
      return `renamed from “${d.from ?? ""}” to “${d.to ?? ""}”`;
    case "baseChanged":
      return `changed the base from ${d.from ?? "?"} to ${d.to ?? "?"}${event.actor === null ? " automatically" : ""}`;
    case "labeled":
      return `${d.added === false ? "removed" : "added"} label ${d.label ?? ""}`;
    case "assigned":
      return `${d.added === false ? "unassigned" : "assigned"} ${target}`;
    case "mentioned":
      return `mentioned ${target}`;
    case "stack":
      return d.added === false ? "removed this from a stack" : "added this to a stack";
    case "connected":
      return `${d.added === false ? "disconnected" : "connected"} ${refText(d.ref)}`;
    case "closedByPr":
      return `closed by ${refText(d.ref)}`;
    case "markedDuplicate":
      return `marked as a duplicate of ${refText(d.ref)}`;
    case "transferred":
      return d.from ? `transferred from ${d.from}` : "transferred";
    case "subIssue": {
      const what = d.typename.startsWith("ParentIssue") ? "parent issue" : "sub-issue";
      return `${d.added === false ? "removed" : "added"} ${what} ${refText(d.ref)}`;
    }
    case "milestoned":
      if (d.added === false) return d.milestone ? `removed this from milestone ${d.milestone}` : "removed the milestone";
      return d.milestone ? `added this to milestone ${d.milestone}` : "set the milestone";
    case "unknown":
      return typenameLabel(d.typename);
  }
}

/** URL to open for an event, if it has one. */
export function eventUrl(event: Event & { extracted?: { url?: string } }): string | null {
  return event.data.url ?? event.extracted?.url ?? null;
}
