import type { SubjectRecord, SubjectViewRecord, ThreadRecord } from "../types.ts";
import { isMe } from "./classify.ts";
import type {
  CiState,
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
  return `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
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
  };
}

function refUrl(repo: string, kind: "pr" | "issue", number: number): string {
  return `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

/**
 * Links for the preview pane: URLs extracted by bot rules (even from hidden events), issues
 * this PR closes, and PRs or issues connected to this one.
 */
export function buildLinks(subject: SubjectRecord, events: ViewEvent[]): ViewLink[] {
  const links: ViewLink[] = [];
  const seen = new Set<string>();
  const add = (label: string, url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ label, url });
  };

  for (const e of events) {
    if (e.extracted?.url) add(e.ruleId ?? e.actor?.login ?? "link", e.extracted.url);
  }
  for (const n of nodes(obj(subject.raw)?.closingIssuesReferences)) {
    if (typeof n.number === "number") add(`closes #${n.number}`, refUrl(subject.repo, "issue", n.number));
  }
  for (const e of events) {
    const ref = e.data.ref;
    if (!ref) continue;
    const linked =
      e.kind === "connected" ||
      e.kind === "closedByPr" ||
      e.kind === "markedDuplicate" ||
      (e.kind === "crossReference" && e.data.willClose === true);
    if (!linked || e.data.added === false) continue;
    const name = ref.repo === subject.repo ? `#${ref.number}` : `${ref.repo}#${ref.number}`;
    add(ref.title ? `${name} ${ref.title}` : name, refUrl(ref.repo, ref.kind, ref.number));
  }
  return links;
}

export function toInboxRow(view: SubjectView): InboxRow {
  const h = view.header;
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
    findings: [],
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
