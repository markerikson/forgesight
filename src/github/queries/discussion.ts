import { type } from "arktype";
import { type QueryShape, queryShape } from "../../core/enrich-plan.ts";
import type { EnrichmentResult } from "../../core/types.ts";
import { GitHubApiError } from "../errors.ts";

/** Newest top-level comments and replies per comment fetched per discussion. Older ones are counted, not fetched. */
const FULL_PAGE = { comments: 50, replies: 20 };
/** Smaller page for the retry after a gateway error or timeout. */
const REDUCED_PAGE = { comments: 20, replies: 5 };

const COMMENT_FIELDS = "id createdAt lastEditedAt author { login __typename } body url isMinimized isAnswer";

export function discussionCore(shape: QueryShape): string {
  const page = shape.timelinePage < queryShape("full", false).timelinePage ? REDUCED_PAGE : FULL_PAGE;
  return `fragment DiscussionCore on Discussion {
  id number title body url createdAt updatedAt lastEditedAt closed closedAt stateReason locked
  isAnswered answerChosenAt answerChosenBy { login __typename } answer { id }
  category { name emoji isAnswerable }
  author { login __typename }
  labels(first: 20) { nodes { name } }
  upvoteCount
  comments(last: ${page.comments}) {
    totalCount
    nodes {
      ${COMMENT_FIELDS}
      replies(last: ${page.replies}) { totalCount nodes { ${COMMENT_FIELDS} replyTo { id } } }
    }
  }
}`;
}

const author = type({ login: "string" }).or("null");

const reply = type({ id: "string", createdAt: "string", body: "string", author, "replyTo?": type({ id: "string" }).or("null") });

const comment = type({
  id: "string",
  createdAt: "string",
  body: "string",
  author,
  replies: { totalCount: "number", nodes: "(object | null)[]" },
});

export const discussionAlias = type({
  id: "string",
  number: "number",
  closed: "boolean",
  closedAt: "string | null",
  "stateReason?": "string | null",
  author,
  updatedAt: "string",
  answerChosenAt: "string | null",
  answerChosenBy: author,
  answer: type({ id: "string" }).or("null"),
  comments: { totalCount: "number", nodes: "(object | null)[]" },
});

function check<T>(schema: (raw: unknown) => T | InstanceType<typeof type.errors>, raw: unknown, what: string): T {
  const out = schema(raw);
  if (out instanceof type.errors) throw new GitHubApiError(`Unexpected ${what} shape from GitHub: ${out.summary}`, 200);
  return out;
}

type Item = EnrichmentResult["timelineItems"][number];

export interface ParsedDiscussion {
  subject: EnrichmentResult["subject"];
  items: Item[];
}

/**
 * Maps a discussion into the timeline item model. Comments and replies become `DiscussionComment` items
 * (replies keep `replyTo`); the chosen answer and the close become synthetic `DiscussionAnswer` and
 * `DiscussionClosed` items, since discussions have no timeline. The subject raw keeps the total comment
 * count and each comment's reply count, so the view can compare them with the stored items.
 */
export function parseDiscussionAlias(raw: unknown): ParsedDiscussion {
  const d = check(discussionAlias, raw, "discussion");
  const items: Item[] = [];
  const seen = new Set<string>();
  const push = (item: Item) => {
    if (seen.has(item.nodeId)) return;
    seen.add(item.nodeId);
    items.push(item);
  };
  const replyCounts: Record<string, number> = {};
  for (const node of d.comments.nodes) {
    if (node === null) continue;
    const c = check(comment, node, "discussion comment");
    const { replies: _replies, ...rest } = node as Record<string, unknown>;
    push({ nodeId: c.id, typename: "DiscussionComment", createdAt: c.createdAt, raw: { __typename: "DiscussionComment", ...rest } });
    replyCounts[c.id] = c.replies.totalCount;
    for (const r of c.replies.nodes) {
      if (r === null) continue;
      const parsed = check(reply, r, "discussion reply");
      push({
        nodeId: parsed.id,
        typename: "DiscussionComment",
        createdAt: parsed.createdAt,
        raw: { __typename: "DiscussionComment", ...(r as Record<string, unknown>), replyTo: { id: c.id } },
      });
    }
  }
  if (d.answer && d.answerChosenAt) {
    push({
      nodeId: `${d.answer.id}:answer`,
      typename: "DiscussionAnswer",
      createdAt: d.answerChosenAt,
      raw: { __typename: "DiscussionAnswer", createdAt: d.answerChosenAt, actor: d.answerChosenBy, commentId: d.answer.id },
    });
  }
  if (d.closed && d.closedAt) {
    push({
      nodeId: `${d.id}:closed:${d.closedAt}`,
      typename: "DiscussionClosed",
      createdAt: d.closedAt,
      raw: { __typename: "DiscussionClosed", createdAt: d.closedAt, stateReason: d.stateReason ?? null },
    });
  }
  const { comments: _comments, ...rest } = raw as Record<string, unknown>;
  return {
    items,
    subject: {
      nodeId: d.id,
      state: d.closed ? "CLOSED" : "OPEN",
      author: d.author?.login ?? null,
      headRef: null,
      baseRef: null,
      headSha: null,
      baseSha: null,
      updatedAt: d.updatedAt,
      raw: { ...rest, commentCount: d.comments.totalCount, replyCounts },
    },
  };
}
