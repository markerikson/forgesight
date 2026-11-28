import { findingIcons } from "../findings/status.ts";
import { CLOSING_RELATIONS } from "../links.ts";
import type { SubjectRecord, SubjectViewRecord, ThreadRecord } from "../types.ts";
import { isMe } from "./classify.ts";
import type {
  CiState,
  DiscussionInfo,
  InboxRow,
  ReviewDecision,
  SubjectHeader,
  SubjectView,
  ViewEvent,
  ViewLink,
} from "./types.ts";

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
}

function nodes(value: unknown): Raw[] {
  const list = obj(value)?.nodes;
  return Array.isArray(list) ? list.map(obj).filter((n) => n !== null) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The description from a subject's stored GraphQL fields. `undefined` means the fields were
 * fetched before the query asked for `body`, so the subject needs another fetch.
 */
export function subjectBody(raw: unknown): string | null | undefined {
  const fields = obj(raw);
  if (!fields || !("body" in fields)) return undefined;
  const body = str(fields.body);
  return body && body.trim() !== "" ? body : null;
}

const CI_STATES = new Set<CiState>(["success", "failure", "pending", "error", "expected"]);
const REVIEW_DECISIONS = new Set<ReviewDecision>(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);

function ciState(raw: Raw | null): CiState | null {
  const [lastCommit] = nodes(raw?.commits);
  const state = str(obj(obj(lastCommit?.commit)?.statusCheckRollup)?.state)?.toLowerCase();
  return state && CI_STATES.has(state as CiState) ? (state as CiState) : null;
}

function reviewDecision(raw: Raw | null): ReviewDecision | null {
  const value = str(raw?.reviewDecision);
  return value && REVIEW_DECISIONS.has(value as ReviewDecision) ? (value as ReviewDecision) : null;
}

export function subjectUrl(repo: string, kind: SubjectRecord["kind"], number: number | null): string | null {
  if (number === null || kind === "other") return null;
  const path = kind === "pr" ? "pull" : kind === "discussion" ? "discussions" : "issues";
  return `https://github.com/${repo}/${path}/${number}`;
}

function count(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Comments and replies GitHub counts but the stored timeline lacks. Each fetch takes only the newest
 * ones, while stored items from earlier fetches stay, so the gap is measured against what is stored.
 */
function omitted(raw: Raw | null, events: ViewEvent[]): { comments: number; replies: number } {
  const stored = events.filter((e) => e.data.typename === "DiscussionComment");
  const comments = Math.max(0, count(raw?.commentCount) - stored.filter((e) => !e.data.replyTo).length);
  let replies = 0;
  for (const [id, total] of Object.entries(obj(raw?.replyCounts) ?? {})) {
    replies += Math.max(0, count(total) - stored.filter((e) => e.data.replyTo === id).length);
  }
  return { comments, replies };
}

function discussionInfo(raw: Raw | null, events: ViewEvent[]): DiscussionInfo {
  const category = obj(raw?.category);
  const missing = omitted(raw, events);
  return {
    category: str(category?.name),
    categoryEmoji: str(category?.emoji),
    answerable: category?.isAnswerable === true,
    answerId: str(obj(raw?.answer)?.id),
    answeredBy: str(obj(raw?.answerChosenBy)?.login),
    answeredAt: str(raw?.answerChosenAt),
    omittedComments: missing.comments,
    omittedReplies: missing.replies,
  };
}

function threadTitle(threads: ThreadRecord[]): string | null {
  for (const t of threads) {
    const title = str(obj(obj(t.raw)?.subject)?.title);
    if (title) return title;
  }
  return null;
}

export function buildHeader(
  subject: SubjectRecord,
  threads: ThreadRecord[],
  events: ViewEvent[],
  me: string | null,
): SubjectHeader {
  const raw = obj(subject.raw);
  const author = obj(raw?.author);
  const latestHuman = events.findLast((e) => e.actor !== null && !e.actor.isBot && !isMe(e.actor.login, me));
  return {
    key: subject.subjectKey,
    repo: subject.repo,
    number: subject.number,
    kind: subject.kind,
    title: str(raw?.title) ?? threadTitle(threads) ?? subject.subjectKey,
    url: subjectUrl(subject.repo, subject.kind, subject.number),
    author: subject.author,
    authorIsBot: str(author?.__typename) === "Bot",
    state: subject.state,
    draft: raw?.isDraft === true,
    merged: subject.state === "MERGED",
    headRef: subject.headRef,
    baseRef: subject.baseRef,
    ciState: ciState(raw),
    reviewDecision: reviewDecision(raw),
    latestHumanActor: latestHuman?.actor?.login ?? null,
    labels: nodes(raw?.labels)
      .map((n) => str(n.name))
      .filter((n) => n !== null),
    enrichError: subject.enrichError,
    ...(subject.kind === "discussion" && { discussion: discussionInfo(raw, events) }),
  };
}

/**
 * Links for the preview pane: URLs extracted by bot rules, even from hidden events. Linked PRs
 * and issues are in `SubjectView.linked`.
 */
export function buildLinks(events: ViewEvent[]): ViewLink[] {
  const links: ViewLink[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const url = e.extracted?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ label: e.ruleId ?? e.actor?.login ?? "link", url });
  }
  return links;
}

export function toInboxRow(view: SubjectView): InboxRow {
  const h = view.header;
  const linked = (view.linked ?? []).filter(
    (l) => CLOSING_RELATIONS.has(l.relation) && !(l.kind === "pr" && l.state === "CLOSED"),
  );
  return {
    key: view.key,
    repo: h.repo,
    number: h.number,
    kind: h.kind,
    title: h.title,
    url: h.url,
    author: h.author,
    state: h.state,
    draft: h.draft,
    merged: h.merged,
    ciState: h.ciState,
    reviewDecision: h.reviewDecision,
    latestActor: h.latestHumanActor,
    section: view.section,
    reasons: view.reasons,
    summaryLine: view.summaryLine,
    newMeaningfulCount: view.newMeaningfulCount,
    hiddenStats: view.hiddenStats,
    sortAt: view.sortAt,
    snoozeUntil: view.snoozeUntil,
    unread: view.unread,
    enrichError: h.enrichError,
    ...(view.quiet ? { quiet: view.quiet } : {}),
    findings: h.state === "OPEN" ? findingIcons(view.findings ?? []) : [],
    ...(linked.length > 0 ? { linked } : {}),
  };
}

export function toViewRecord(
  view: SubjectView,
  meta: { pipelineVersion: number; configHash: string; computedAt: string },
): SubjectViewRecord {
  return {
    subjectKey: view.key,
    pipelineVersion: meta.pipelineVersion,
    configHash: meta.configHash,
    section: view.section,
    sortAt: view.sortAt,
    score: view.score,
    repo: view.header.repo,
    stackId: view.stack?.workstreamId ?? null,
    row: { ...toInboxRow(view) },
    detail: { ...view },
    computedAt: meta.computedAt,
  };
}
