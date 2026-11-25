import type { QueryShape } from "../../core/enrich-plan.ts";

// Never add files, changedFiles, commits { totalCount }, additions or deletions: they make
// SubjectBatch time out on large repos.

const ACTOR = "actor { login __typename }";
const SOURCE = `source { __typename
  ... on PullRequest { number title state repository { nameWithOwner } }
  ... on Issue { number title state repository { nameWithOwner } } }`;

/** Item fields shared by PR and issue timelines. Every item has `__typename`; nodes have `id`. */
const COMMON_ITEMS = `
  __typename
  ... on Node { id }
  ... on IssueComment { createdAt updatedAt lastEditedAt author { login __typename } body url }
  ... on CrossReferencedEvent { createdAt ${ACTOR} willCloseTarget isCrossRepository ${SOURCE} }
  ... on ReferencedEvent { createdAt ${ACTOR} isCrossRepository commit { oid messageHeadline } }
  ... on ConnectedEvent { createdAt ${ACTOR} isCrossRepository ${SOURCE} }
  ... on DisconnectedEvent { createdAt ${ACTOR} isCrossRepository ${SOURCE} }
  ... on ClosedEvent { createdAt ${ACTOR} stateReason closer { __typename ... on PullRequest { number } ... on Commit { oid } } }
  ... on ReopenedEvent { createdAt ${ACTOR} }
  ... on AssignedEvent { createdAt ${ACTOR} assignee { ... on Actor { login } } }
  ... on UnassignedEvent { createdAt ${ACTOR} assignee { ... on Actor { login } } }
  ... on LabeledEvent { createdAt ${ACTOR} label { name } }
  ... on UnlabeledEvent { createdAt ${ACTOR} label { name } }
  ... on MentionedEvent { createdAt ${ACTOR} }
  ... on RenamedTitleEvent { createdAt ${ACTOR} previousTitle currentTitle }
  ... on MilestonedEvent { createdAt ${ACTOR} milestoneTitle }
  ... on DemilestonedEvent { createdAt ${ACTOR} milestoneTitle }
`;

/** PullRequestTimelineItems fields. */
export const PR_ITEMS = `fragment PrItems on PullRequestTimelineItems {${COMMON_ITEMS}
  ... on PullRequestReview { createdAt submittedAt state author { login __typename } body commit { oid }
    comments(first: 10) { nodes { id path body author { login } } } }
  ... on PullRequestCommit { commit { oid messageHeadline authoredDate committedDate author { user { login } } } }
  ... on HeadRefForcePushedEvent { createdAt ${ACTOR} beforeCommit { oid } afterCommit { oid } }
  ... on BaseRefForcePushedEvent { createdAt ${ACTOR} beforeCommit { oid } afterCommit { oid } }
  ... on BaseRefChangedEvent { createdAt ${ACTOR} previousRefName currentRefName }
  ... on AutomaticBaseChangeSucceededEvent { createdAt oldBase newBase }
  ... on ReviewRequestedEvent { createdAt ${ACTOR} requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } }
  ... on ReviewRequestRemovedEvent { createdAt ${ACTOR} requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } }
  ... on ReviewDismissedEvent { createdAt ${ACTOR} previousReviewState dismissalMessage }
  ... on ReadyForReviewEvent { createdAt ${ACTOR} }
  ... on ConvertToDraftEvent { createdAt ${ACTOR} }
  ... on MergedEvent { createdAt ${ACTOR} commit { oid } }
  ... on AddedToStackEvent { createdAt ${ACTOR} }
  ... on RemovedFromStackEvent { createdAt ${ACTOR} }
}`;

/** IssueTimelineItems fields. Other item types arrive with `__typename` and `id` only. */
export const ISSUE_ITEMS = `fragment IssueItems on IssueTimelineItems {${COMMON_ITEMS}
  ... on MarkedAsDuplicateEvent { createdAt ${ACTOR} canonical { __typename ... on Issue { number } ... on PullRequest { number } } }
  ... on TransferredEvent { createdAt ${ACTOR} fromRepository { nameWithOwner } }
  ... on SubIssueAddedEvent { createdAt ${ACTOR} subIssue { number title } }
  ... on ParentIssueAddedEvent { createdAt ${ACTOR} parent { number title } }
  ... on SubIssueRemovedEvent { createdAt ${ACTOR} subIssue { number title } }
  ... on ParentIssueRemovedEvent { createdAt ${ACTOR} parent { number title } }
}`;

const CHECKS = {
  contexts: `commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl } } } } } } }`,
  rollup: "commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }",
} as const;

export function prCore(shape: QueryShape): string {
  const threads =
    shape.reviewThreads > 0
      ? `reviewThreads(last: ${shape.reviewThreads}) { nodes { id isResolved isOutdated path line
    comments(first: 1) { nodes { id author { login } body createdAt } } } }`
      : "";
  return `fragment PrCore on PullRequest {
  id number title state isDraft author { login __typename } body
  baseRefName headRefName baseRefOid headRefOid mergedAt closedAt updatedAt reviewDecision
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
  latestReviews(first: 20) { nodes { id state author { login } submittedAt } }
  closingIssuesReferences(first: 5) { nodes { number } }
  ${CHECKS[shape.checks]}
  ${threads}
}`;
}

export const ISSUE_CORE = `fragment IssueCore on Issue {
  id number title state stateReason author { login __typename } body createdAt updatedAt closedAt
  assignees(first: 10) { nodes { login } }
  labels(first: 20) { nodes { name } }
  issueType { name }
  parent { number title }
  subIssuesSummary { total completed }
}`;

export const STICKY_FIELDS = "... on IssueComment { id body lastEditedAt updatedAt author { login __typename } }";
