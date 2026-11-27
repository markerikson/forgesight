import { type } from "arktype";
import { isStickyCandidate, type QueryShape, type StickyMarker } from "../../core/enrich-plan.ts";
import type { EnrichmentResult, SubjectKey } from "../../core/types.ts";
import { GitHubApiError } from "../errors.ts";
import type { GqlErrorEntry } from "../types.ts";
import { discussionCore, parseDiscussionAlias } from "./discussion.ts";
import { ISSUE_CORE, ISSUE_ITEMS, PR_ITEMS, prCore, STICKY_FIELDS } from "./fragments.ts";

export interface BatchSubject {
  subjectKey: SubjectKey;
  kind: "pr" | "issue" | "discussion";
  number: number;
  /** `timelineItems(since:)`; null fetches the whole timeline. */
  since: string | null;
  /** Fetch only the timeline page after this cursor, without the core fields. */
  after?: string;
}

export interface SubjectBatchInput {
  repo: string;
  subjects: BatchSubject[];
  stickyIds: string[];
  shape: QueryShape;
}

export interface SubjectBatchQuery {
  query: string;
  variables: { owner: string; name: string; stickyIds: string[] };
  /** Alias for each subject, in input order. */
  aliases: string[];
}

function timelineArgs(subject: BatchSubject, first: number): string {
  const args = [];
  if (subject.since) args.push(`since: ${JSON.stringify(subject.since)}`);
  args.push(`first: ${first}`);
  if (subject.after) args.push(`after: ${JSON.stringify(subject.after)}`);
  return args.join(", ");
}

function aliasField(subject: BatchSubject, alias: string, shape: QueryShape): string {
  // Discussions have no timeline or cursor: the core fragment carries the newest comments and replies.
  if (subject.kind === "discussion") return `    ${alias}: discussion(number: ${subject.number}) { ...DiscussionCore }`;
  const field = subject.kind === "pr" ? "pullRequest" : "issue";
  const core = subject.after ? "" : subject.kind === "pr" ? "...PrCore " : "...IssueCore ";
  const items = subject.kind === "pr" ? "...PrItems" : "...IssueItems";
  return `    ${alias}: ${field}(number: ${subject.number}) { ${core}timelineItems(${timelineArgs(subject, shape.timelinePage)}) { pageInfo { hasNextPage endCursor } nodes { ${items} } } }`;
}

export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length) throw new Error(`Bad repo name: ${repo}`);
  return { owner, name };
}

/** Builds one SubjectBatch query. Since and cursors are inlined per alias; only used fragments are defined. */
export function buildSubjectBatchQuery(input: SubjectBatchInput): SubjectBatchQuery {
  const aliases = input.subjects.map((_, i) => `s${i}`);
  const fields = input.subjects.map((s, i) => aliasField(s, aliases[i] ?? `s${i}`, input.shape));
  const fragments: string[] = [];
  const prs = input.subjects.filter((s) => s.kind === "pr");
  const issues = input.subjects.filter((s) => s.kind === "issue");
  if (prs.some((s) => !s.after)) fragments.push(prCore(input.shape));
  if (prs.length) fragments.push(PR_ITEMS);
  if (issues.some((s) => !s.after)) fragments.push(ISSUE_CORE);
  if (issues.length) fragments.push(ISSUE_ITEMS);
  if (input.subjects.some((s) => s.kind === "discussion")) fragments.push(discussionCore(input.shape));
  const query = `query SubjectBatch($owner: String!, $name: String!, $stickyIds: [ID!]!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
${fields.join("\n")}
  }
  stickies: nodes(ids: $stickyIds) { ${STICKY_FIELDS} }
}
${fragments.join("\n")}
`;
  return { query, variables: { ...splitRepo(input.repo), stickyIds: input.stickyIds }, aliases };
}

const author = type({ login: "string" }).or("null");

export const timelineItem = type({ __typename: "string", "id?": "string", "createdAt?": "string" });

/** Stricter checks for the item types we read fields from. Other types only need the generic shape. */
const itemSchemas: Record<string, (raw: unknown) => unknown> = {
  IssueComment: type({ id: "string", createdAt: "string", body: "string", "lastEditedAt?": "string | null", author }),
  PullRequestReview: type({ id: "string", createdAt: "string", state: "string", author }),
  PullRequestCommit: type({ id: "string", commit: { oid: "string", committedDate: "string" } }),
};

const timelinePage = type({
  pageInfo: { hasNextPage: "boolean", endCursor: "string | null" },
  // Some items come back null (seen on several RTK pull requests); they are skipped.
  nodes: "(object | null)[]",
});

const reviewThread = type({
  id: "string",
  isResolved: "boolean",
  isOutdated: "boolean",
  path: "string | null",
  line: "number | null",
});

export const prAlias = type({
  id: "string",
  number: "number",
  state: "'OPEN' | 'CLOSED' | 'MERGED'",
  author,
  baseRefName: "string",
  headRefName: "string",
  baseRefOid: "string",
  headRefOid: "string",
  updatedAt: "string",
  "reviewThreads?": { nodes: reviewThread.array() },
  timelineItems: timelinePage,
});

export const issueAlias = type({
  id: "string",
  number: "number",
  state: "'OPEN' | 'CLOSED'",
  author,
  updatedAt: "string",
  timelineItems: timelinePage,
});

const pageAlias = type({ timelineItems: timelinePage });

const stickyNode = type({
  id: "string",
  body: "string",
  lastEditedAt: "string | null",
  author,
});

function check<T>(schema: (raw: unknown) => T | InstanceType<typeof type.errors>, raw: unknown, what: string): T {
  const out = schema(raw);
  if (out instanceof type.errors) throw new GitHubApiError(`Unexpected ${what} shape from GitHub: ${out.summary}`, 200);
  return out;
}

export type ParsedItem = EnrichmentResult["timelineItems"][number];
export type ParsedSticky = EnrichmentResult["stickies"][number];

export interface ParsedPage {
  items: ParsedItem[];
  /** Sticky comments found among the items. */
  stickies: ParsedSticky[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ParsedAlias extends ParsedPage {
  subject: EnrichmentResult["subject"];
  /** Absent for issues and for repos that skip review threads. */
  reviewThreads?: NonNullable<EnrichmentResult["reviewThreads"]>;
}

function createdAtOf(raw: Record<string, unknown>, fallback: string): string {
  if (typeof raw.createdAt === "string") return raw.createdAt;
  const commit = raw.commit as { committedDate?: unknown } | undefined;
  if (commit && typeof commit.committedDate === "string") return commit.committedDate;
  return fallback;
}

function parseItems(page: typeof timelinePage.infer, fetchedAt: string, markers: StickyMarker[]): ParsedPage {
  const items: ParsedItem[] = [];
  const stickies: ParsedSticky[] = [];
  const seen = new Set<string>();
  for (const node of page.nodes) {
    if (node === null) continue;
    const generic = check(timelineItem, node, "timeline item");
    const specific = itemSchemas[generic.__typename];
    if (specific) check(specific, node, generic.__typename);
    if (!generic.id || seen.has(generic.id)) continue;
    seen.add(generic.id);
    const raw = node as Record<string, unknown>;
    items.push({ nodeId: generic.id, typename: generic.__typename, createdAt: createdAtOf(raw, fetchedAt), raw: node });
    if (generic.__typename === "IssueComment") {
      const comment = node as { body: string; lastEditedAt?: string | null; author: { login: string } | null };
      const authorLogin = comment.author?.login ?? null;
      if (authorLogin && isStickyCandidate({ typename: "IssueComment", authorLogin, body: comment.body }, markers)) {
        stickies.push({ commentNodeId: generic.id, author: authorLogin, lastEditedAt: comment.lastEditedAt ?? null, body: comment.body });
      }
    }
  }
  return { items, stickies, hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor };
}

function withoutLists(raw: Record<string, unknown>): Record<string, unknown> {
  const { timelineItems: _items, reviewThreads: _threads, ...rest } = raw;
  return rest;
}

/** Validates and maps one subject alias. Unknown timeline item types are kept as raw items. */
export function parseSubjectAlias(
  raw: unknown,
  kind: "pr" | "issue" | "discussion",
  ctx: { fetchedAt: string; markers: StickyMarker[] },
): ParsedAlias {
  if (kind === "discussion") {
    const { subject, items } = parseDiscussionAlias(raw);
    return { subject, items, stickies: [], hasNextPage: false, endCursor: null };
  }
  if (kind === "issue") {
    const issue = check(issueAlias, raw, "issue");
    return {
      ...parseItems(issue.timelineItems, ctx.fetchedAt, ctx.markers),
      subject: {
        nodeId: issue.id,
        state: issue.state,
        author: issue.author?.login ?? null,
        headRef: null,
        baseRef: null,
        headSha: null,
        baseSha: null,
        updatedAt: issue.updatedAt,
        raw: withoutLists(raw as Record<string, unknown>),
      },
    };
  }
  const pr = check(prAlias, raw, "pull request");
  const parsed: ParsedAlias = {
    ...parseItems(pr.timelineItems, ctx.fetchedAt, ctx.markers),
    subject: {
      nodeId: pr.id,
      state: pr.state,
      author: pr.author?.login ?? null,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid,
      updatedAt: pr.updatedAt,
      raw: withoutLists(raw as Record<string, unknown>),
    },
  };
  if (pr.reviewThreads) {
    const nodes = (raw as { reviewThreads: { nodes: unknown[] } }).reviewThreads.nodes;
    parsed.reviewThreads = pr.reviewThreads.nodes.map((t, i) => ({
      nodeId: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line,
      raw: nodes[i],
    }));
  }
  return parsed;
}

/** Parses a follow-up alias that fetched only a timeline page. */
export function parseTimelinePage(raw: unknown, ctx: { fetchedAt: string; markers: StickyMarker[] }): ParsedPage {
  return parseItems(check(pageAlias, raw, "timeline page").timelineItems, ctx.fetchedAt, ctx.markers);
}

/** Current sticky comment bodies by node id. Deleted comments come back null and are skipped. */
export function parseStickies(raw: unknown): Map<string, ParsedSticky> {
  const out = new Map<string, ParsedSticky>();
  if (!Array.isArray(raw)) return out;
  for (const node of raw) {
    if (!node || typeof node !== "object" || !("id" in node)) continue;
    const s = check(stickyNode, node, "sticky comment");
    if (!s.author) continue;
    out.set(s.id, { commentNodeId: s.id, author: s.author.login, lastEditedAt: s.lastEditedAt, body: s.body });
  }
  return out;
}

/** GraphQL errors grouped by subject alias (`repository.sN`). Errors without an alias path are under "". */
export function errorsByAlias(errors: GqlErrorEntry[] | undefined): Map<string, GqlErrorEntry[]> {
  const out = new Map<string, GqlErrorEntry[]>();
  for (const error of errors ?? []) {
    const path = error.path ?? [];
    const alias = path[0] === "repository" && typeof path[1] === "string" ? path[1] : "";
    const list = out.get(alias) ?? [];
    list.push(error);
    out.set(alias, list);
  }
  return out;
}
