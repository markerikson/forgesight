import { describe, expect, test } from "bun:test";
import type { Event } from "../core/index.ts";
import { describeEvent } from "./events.ts";
import { relativeTime, repoShortName, rowByline, stateBadge } from "./format.ts";
import { parseUrlState } from "./hooks/useUrlState.ts";

function event(kind: Event["kind"], data: Partial<Event["data"]> = {}): Event {
  return { id: "e1", at: "2026-11-23T10:00:00Z", actor: null, kind, data: { typename: "X", ...data } };
}

describe("describeEvent", () => {
  test("reviews include state and inline comment count", () => {
    expect(describeEvent(event("review", { reviewState: "APPROVED" }))).toBe("approved");
    expect(describeEvent(event("review", { reviewState: "CHANGES_REQUESTED", commentCount: 2 }))).toBe(
      "requested changes with 2 comments",
    );
  });

  test("pushes show the short sha and headline", () => {
    expect(describeEvent(event("commit", { sha: "1234567890abc", headline: "Fix tests" }))).toBe("pushed 1234567 Fix tests");
    expect(describeEvent(event("forcePush", { beforeSha: "aaaaaaaaa", afterSha: "bbbbbbbbb" }))).toBe(
      "force-pushed aaaaaaa → bbbbbbb",
    );
  });

  test("references name the other item", () => {
    expect(
      describeEvent(event("crossReference", { ref: { kind: "pr", repo: "o/r", number: 5, title: "Fix" }, willClose: true })),
    ).toBe("will close this from o/r#5 Fix");
    expect(describeEvent(event("labeled", { label: "bug", added: false }))).toBe("removed label bug");
  });

  test("unknown events fall back to a readable typename", () => {
    expect(describeEvent(event("unknown", { typename: "AutoMergeEnabledEvent" }))).toBe("auto merge enabled");
  });

  test("milestone changes name the milestone when it is known", () => {
    expect(describeEvent(event("milestoned", { milestone: "6.0", added: true }))).toBe("added this to milestone 6.0");
    expect(describeEvent(event("milestoned", { added: false }))).toBe("removed the milestone");
  });
});

describe("rowByline", () => {
  test("drops the author's login from the summary and repeated latest actors", () => {
    expect(rowByline("Domiii", "Domiii pushed: fix", "Domiii")).toEqual({ summary: "pushed: fix", actor: null });
    expect(rowByline("bob", "alice commented: hi", "alice")).toEqual({ summary: "alice commented: hi", actor: null });
  });

  test("keeps a latest actor who is named nowhere else", () => {
    expect(rowByline("bob", "referenced in o/r#4", "carol")).toEqual({ summary: "referenced in o/r#4", actor: "carol" });
    expect(rowByline(null, "", "carol")).toEqual({ summary: "", actor: "carol" });
  });
});

describe("parseUrlState", () => {
  test("reads section, repo and selection", () => {
    expect(parseUrlState("?section=updates&repo=replayio%2Fbackend&sel=replayio%2Fbackend%2314148")).toEqual({
      section: "updates",
      repo: "replayio/backend",
      selectedKey: "replayio/backend#14148",
    });
  });

  test("ignores unknown sections and empty values", () => {
    expect(parseUrlState("?section=bogus&repo=&sel=")).toEqual({});
  });
});

describe("format", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");

  test("relativeTime buckets", () => {
    expect(relativeTime("2026-11-23T11:59:30Z", now)).toBe("now");
    expect(relativeTime("2026-11-23T11:55:00Z", now)).toBe("5m");
    expect(relativeTime("2026-11-23T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-11-19T12:00:00Z", now)).toBe("4d");
    expect(relativeTime("2026-01-01T00:00:00Z", now)).toBe("2026-01-01");
    expect(relativeTime("garbage", now)).toBe("");
  });

  test("repoShortName and stateBadge", () => {
    expect(repoShortName("replayio/backend")).toBe("backend");
    expect(stateBadge("pr", "OPEN", false, true).tone).toBe("merged");
    expect(stateBadge("pr", "OPEN", true, false).tone).toBe("draft");
    expect(stateBadge("issue", "CLOSED", false, false).label).toBe("Closed issue");
  });
});
