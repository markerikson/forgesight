import { describe, expect, test } from "bun:test";
import { GitHubApiError } from "../errors.ts";
import { queryShape } from "../../core/enrich-plan.ts";
import { discussionCore, parseDiscussionAlias } from "./discussion.ts";

const author = (login: string) => ({ login, __typename: "User" });

function discussion(overrides: Record<string, unknown> = {}) {
  return {
    id: "D1",
    number: 42,
    title: "How do I?",
    body: "question",
    closed: false,
    closedAt: null,
    stateReason: null,
    author: author("alice"),
    updatedAt: "2026-11-21T00:00:00Z",
    answerChosenAt: null,
    answerChosenBy: null,
    answer: null,
    category: { name: "Q&A", emoji: ":pray:", isAnswerable: true },
    comments: {
      totalCount: 3,
      nodes: [
        {
          id: "C1",
          createdAt: "2026-11-20T01:00:00Z",
          body: "try this",
          author: author("bob"),
          isAnswer: true,
          replies: {
            totalCount: 4,
            nodes: [{ id: "R1", createdAt: "2026-11-20T02:00:00Z", body: "thanks", author: author("alice"), replyTo: { id: "C1" } }],
          },
        },
        { id: "C2", createdAt: "2026-11-20T03:00:00Z", body: "me too", author: null, replies: { totalCount: 0, nodes: [] } },
      ],
    },
    ...overrides,
  };
}

describe("parseDiscussionAlias", () => {
  test("flattens comments and replies into items and counts what was not fetched", () => {
    const { subject, items } = parseDiscussionAlias(discussion());
    expect(items.map((i) => [i.nodeId, i.typename])).toEqual([
      ["C1", "DiscussionComment"],
      ["R1", "DiscussionComment"],
      ["C2", "DiscussionComment"],
    ]);
    expect(items[1]?.raw).toMatchObject({ replyTo: { id: "C1" } });
    expect(items[0]?.raw).not.toHaveProperty("replies");
    expect(subject).toMatchObject({ nodeId: "D1", state: "OPEN", author: "alice", updatedAt: "2026-11-21T00:00:00Z" });
    expect(subject.raw).toMatchObject({ commentCount: 3, replyCounts: { C1: 4, C2: 0 }, title: "How do I?" });
    expect(subject.raw).not.toHaveProperty("comments");
  });

  test("adds synthetic items for the chosen answer and the close", () => {
    const { subject, items } = parseDiscussionAlias(
      discussion({
        closed: true,
        closedAt: "2026-11-21T00:00:00Z",
        stateReason: "RESOLVED",
        answer: { id: "C1" },
        answerChosenAt: "2026-11-20T05:00:00Z",
        answerChosenBy: author("alice"),
      }),
    );
    expect(subject.state).toBe("CLOSED");
    const answer = items.find((i) => i.typename === "DiscussionAnswer");
    expect(answer).toMatchObject({ nodeId: "C1:answer", createdAt: "2026-11-20T05:00:00Z" });
    expect(answer?.raw).toMatchObject({ commentId: "C1", actor: { login: "alice" } });
    const closed = items.find((i) => i.typename === "DiscussionClosed");
    expect(closed).toMatchObject({ nodeId: "D1:closed:2026-11-21T00:00:00Z", createdAt: "2026-11-21T00:00:00Z" });
  });

  test("the reduced query shape fetches fewer comments and replies", () => {
    expect(discussionCore(queryShape("full", false))).toContain("comments(last: 50)");
    const reduced = discussionCore(queryShape("full", true));
    expect(reduced).toContain("comments(last: 20)");
    expect(reduced).toContain("replies(last: 5)");
  });

  test("rejects an unexpected shape", () => {
    expect(() => parseDiscussionAlias({ id: "D1" })).toThrow(GitHubApiError);
  });
});
