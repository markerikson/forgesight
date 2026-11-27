import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../../config/load.ts";
import type { RepoMode } from "../config.ts";
import type { PushVerdict } from "../rebase/patch.ts";
import type {
  ItemState,
  StickyCommentVersion,
  SubjectRecord,
  ThreadRecord,
  TimelineItemRecord,
} from "../types.ts";
import { deriveSubjectView, subjectBody } from "./index.ts";

const ME = "markerikson";
const REPO = "replayio/backend";
const KEY = `${REPO}#1`;
const DISMISSED = "2026-11-20T00:00:00Z";
const NOW = new Date("2026-11-22T00:00:00Z");
// My open PRs always wait unless marked done, so tests about which activity counts on my PR mark it done first.
const DONE_MINE = { author: ME, itemState: { doneAt: DISMISSED } };

const user = (login: string) => ({ login, __typename: "User" });
const bot = (login: string) => ({ login, __typename: "Bot" });

let seq = 0;
function item(typename: string, createdAt: string, raw: Record<string, unknown>): TimelineItemRecord {
  seq++;
  return {
    nodeId: `N${seq}`,
    subjectKey: KEY,
    typename,
    createdAt,
    raw: { __typename: typename, id: `N${seq}`, createdAt, ...raw },
    fetchedAt: NOW.toISOString(),
  };
}

const comment = (login: string, at: string, body: string, isBot = false) =>
  item("IssueComment", at, { author: isBot ? bot(login) : user(login), body, url: `https://x/${seq}` });

const commit = (at: string, headline = "change") =>
  item("PullRequestCommit", at, {
    commit: { oid: `sha${seq}`, messageHeadline: headline, committedDate: at, author: { user: { login: "bob" } } },
  });

const forcePush = (at: string, after = "b") =>
  item("HeadRefForcePushedEvent", at, { actor: user("bob"), beforeCommit: { oid: "a" }, afterCommit: { oid: after } });

const rename = (at: string) =>
  item("RenamedTitleEvent", at, { actor: user("bob"), previousTitle: "a", currentTitle: "b" });

interface Opts {
  items?: TimelineItemRecord[];
  author?: string;
  state?: SubjectRecord["state"];
  kind?: SubjectRecord["kind"];
  raw?: Record<string, unknown>;
  reason?: string;
  mode?: RepoMode;
  itemState?: Partial<ItemState>;
  enriched?: boolean;
  bots?: Parameters<typeof resolveConfig>[0]["bots"];
  enrichIssues?: boolean;
  pushVerdicts?: Map<string, PushVerdict>;
  stickies?: StickyCommentVersion[];
  headSha?: string;
}

function derive(opts: Opts) {
  const subject: SubjectRecord = {
    subjectKey: KEY,
    repo: REPO,
    number: 1,
    kind: opts.kind ?? "pr",
    nodeId: "S1",
    origin: "thread",
    state: opts.state ?? "OPEN",
    author: opts.author ?? "bob",
    headRef: null,
    baseRef: null,
    headSha: opts.headSha ?? null,
    baseSha: null,
    updatedAt: "2026-11-21T00:00:00Z",
    timelineSyncedUntil: opts.enriched === false ? null : "2026-11-21T00:00:00Z",
    dirtyAt: null,
    priority: 0,
    enrichError: null,
    enrichAttempts: 0,
    raw: { title: "A change", author: user(opts.author ?? "bob"), ...opts.raw },
  };
  const thread: ThreadRecord = {
    threadId: "T1",
    subjectKey: KEY,
    repo: REPO,
    subjectType: "PullRequest",
    reason: opts.reason ?? "subscribed",
    unread: true,
    updatedAt: "2026-11-21T00:00:00Z",
    lastReadAt: DISMISSED,
    firstSeenAt: DISMISSED,
    ghDoneAt: null,
    subjectUrl: null,
    raw: {},
  };
  return deriveSubjectView({
    subject,
    threads: [thread],
    items: opts.items ?? [],
    reviewThreads: [],
    stickies: opts.stickies ?? [],
    state: {
      dismissedAt: DISMISSED,
      keepUnread: false,
      snoozeUntil: null,
      snoozeUntilHumanEvent: false,
      snoozeUntilReady: false,
      snoozedAt: null,
      doneAt: null,
      readAt: null,
      muted: false,
      ...opts.itemState,
    },
    config: resolveConfig({
      me: ME,
      repos: { [REPO]: { mode: opts.mode ?? "full" } },
      ...(opts.bots ? { bots: opts.bots } : {}),
      ...(opts.enrichIssues === undefined ? {} : { polling: { enrichIssues: opts.enrichIssues } }),
    }),
    me: ME,
    now: NOW,
    ...(opts.pushVerdicts ? { pushVerdicts: opts.pushVerdicts } : {}),
  });
}

describe("rank", () => {
  test("before enrichment the summary names only reasons other than watching the repo", () => {
    expect(derive({ enriched: false }).summaryLine).toBe("not loaded yet");
    const mention = derive({ enriched: false, reason: "mention" });
    expect(mention.summaryLine).toBe("mentioned you");
    expect(mention.section).toBe("waiting");
    expect(derive({ enriched: false, reason: "ci_activity" }).summaryLine).toBe("ci activity");
  });

  test("subjects the worker never fetches do not claim to be loading", () => {
    expect(derive({ enriched: false, kind: "other" }).summaryLine).toBe("no details loaded");
    expect(derive({ enriched: false, kind: "issue", enrichIssues: false }).summaryLine).toBe("bob opened this issue");
    expect(derive({ enriched: false, kind: "issue" }).summaryLine).toBe("not loaded yet");
  });

  test("a mention in the description (MentionedEvent with me as actor) is waiting", () => {
    const view = derive({ items: [item("MentionedEvent", "2026-11-21T01:00:00Z", { actor: user(ME) })] });
    expect(view.section).toBe("waiting");
    expect(view.reasons).toContain("mentioned");
  });

  test("a bot rule written with a [bot] suffix matches the bare login", () => {
    const view = derive({
      bots: [{ id: "foo", match: { author: "foo[bot]" }, level: "hidden" }],
      items: [comment("foo", "2026-11-21T01:00:00Z", "status", true)],
    });
    expect(view.rounds[0]?.hiddenCount).toBe(1);
  });

  test("mute applies to subjects that were never enriched", () => {
    const view = derive({ enriched: false, itemState: { muted: true } });
    expect(view.section).toBe("hidden");
    expect(view.reasons).toContain("muted");
  });

  test("open review request for me is waiting until I review", () => {
    const raw = { reviewRequests: { nodes: [{ requestedReviewer: user(ME) }] } };
    const request = item("ReviewRequestedEvent", "2026-11-21T01:00:00Z", {
      actor: user("bob"),
      requestedReviewer: user(ME),
    });
    const view = derive({ raw, items: [request] });
    expect(view.section).toBe("waiting");
    expect(view.reasons).toContain("reviewRequested");
    expect(view.summaryLine).toBe("bob requested review from markerikson");

    const review = item("PullRequestReview", "2026-11-21T02:00:00Z", {
      author: user(ME),
      state: "COMMENTED",
      submittedAt: "2026-11-21T02:00:00Z",
      body: "looks fine",
    });
    expect(derive({ raw, items: [request, review] }).reasons).not.toContain("reviewRequested");
  });

  test("a new comment mentioning me is waiting", () => {
    const view = derive({ items: [comment("alice", "2026-11-21T00:00:00Z", "@markerikson can you look?")] });
    expect(view.section).toBe("waiting");
    expect(view.reasons).toEqual(["mentioned"]);
    expect(view.summaryLine).toBe("alice commented: @markerikson can you look?");
    expect(view.newMeaningfulCount).toBe(1);
  });

  test("a mention inside a code block does not count", () => {
    const view = derive({ items: [comment("alice", "2026-11-21T00:00:00Z", "```\n@markerikson\n```")] });
    expect(view.section).toBe("updates");
  });

  test("a human comment on my PR is waiting", () => {
    const view = derive({ ...DONE_MINE, items: [comment("alice", "2026-11-21T00:00:00Z", "nit")] });
    expect(view.section).toBe("waiting");
    expect(view.reasons).toEqual(["onMine", "myOpenPr"]);
  });

  test("my open PRs, drafts included, are waiting with no new activity", () => {
    const open = derive({ author: ME });
    expect(open.section).toBe("waiting");
    expect(open.reasons).toEqual(["myOpenPr"]);
    expect(derive({ author: ME, raw: { isDraft: true } }).section).toBe("waiting");
  });

  test("marking my open PR done clears it until something new shows", () => {
    expect(derive(DONE_MINE).section).toBe("hidden");
    const later = derive({ ...DONE_MINE, items: [comment("alice", "2026-11-21T00:00:00Z", "nit")] });
    expect(later.reasons).toContain("myOpenPr");
    expect(later.section).toBe("waiting");
  });

  test("my closed PRs and my issues do not get the open PR reason", () => {
    expect(derive({ author: ME, state: "MERGED" }).reasons).not.toContain("myOpenPr");
    expect(derive({ author: ME, state: "CLOSED" }).reasons).not.toContain("myOpenPr");
    expect(derive({ author: ME, kind: "issue" }).reasons).not.toContain("myOpenPr");
  });

  test("a muted or snoozed open PR of mine still follows the override", () => {
    expect(derive({ author: ME, itemState: { muted: true } }).section).toBe("hidden");
    expect(derive({ author: ME, itemState: { snoozeUntil: "2026-11-23T00:00:00Z" } }).section).toBe("snoozed");
  });

  test("a human comment on a subscribed PR is an update", () => {
    const view = derive({ items: [comment("alice", "2026-11-21T00:00:00Z", "nit")] });
    expect(view.section).toBe("updates");
    expect(view.reasons).toEqual(["newActivity"]);
  });

  test("comments before dismissedAt and my own comments are not new", () => {
    const view = derive({
      items: [comment("alice", "2026-11-19T00:00:00Z", "old"), comment(ME, "2026-11-21T00:00:00Z", "mine")],
    });
    expect(view.section).toBe("hidden");
    expect(view.reasons).toEqual(["nothingNew"]);
  });

  test("agent output posted under a human login does not count as human activity", () => {
    const view = derive({ ...DONE_MINE, items: [comment("bhackett1024", "2026-11-21T00:00:00Z", "🤖 Superseded by #2")] });
    expect(view.section).toBe("hidden");
  });

  test("socket comments are hidden unless they carry a caution block on my own PR", () => {
    const quiet = derive({ ...DONE_MINE, items: [comment("socket-security", "2026-11-21T00:00:00Z", "All good", true)] });
    expect(quiet.section).toBe("hidden");
    const cautionItems = () => [comment("socket-security", "2026-11-21T00:00:00Z", "> [!CAUTION]\n> risky dep", true)];
    const mine = derive({ ...DONE_MINE, items: cautionItems() });
    expect(mine.reasons).not.toContain("onMine");
    expect(mine.rounds[0]?.entries[0]).toMatchObject({ type: "event", event: { ruleId: "socket", level: "show" } });
    const theirs = derive({ items: cautionItems() });
    expect(theirs.section).toBe("hidden");
  });

  test("a review request older than the cutoff with nothing since is not waiting", () => {
    const request = (at: string) =>
      item("ReviewRequestedEvent", at, { actor: user("bob"), requestedReviewer: user(ME) });
    const raw = { reviewRequests: { nodes: [{ requestedReviewer: user(ME) }] } };
    const fresh = derive({ raw, items: [request("2026-11-19T00:00:00Z")] });
    expect(fresh.section).toBe("waiting");
    expect(fresh.reasons).toContain("reviewRequested");
    const old = derive({ raw, items: [request("2026-11-10T00:00:00Z")] });
    expect(old.section).toBe("hidden");
    expect(old.reasons).toContain("staleReviewRequest");
    const revived = derive({
      raw,
      items: [request("2026-11-10T00:00:00Z"), comment("alice", "2026-11-21T00:00:00Z", "any thoughts?")],
    });
    expect(revived.section).toBe("waiting");
    expect(revived.reasons).toContain("reviewRequested");
  });

  test("events without a GitHub timestamp are never new", () => {
    const pinned = item("PinnedEvent", "2026-11-21T00:00:00Z", {});
    delete (pinned.raw as Record<string, unknown>).createdAt;
    const view = derive({ items: [pinned] });
    expect(view.section).toBe("hidden");
    const entries = view.rounds.flatMap((r) => r.entries);
    expect(entries).toHaveLength(1);
    expect(entries.every((e) => e.type === "group" && !e.group.isNew)).toBe(true);
  });

  test("an automatic base change reads without an actor", () => {
    const view = derive({
      state: "CLOSED",
      items: [item("AutomaticBaseChangeSucceededEvent", "2026-11-19T00:00:00Z", { oldBase: "feat", newBase: "main" })],
    });
    expect(view.summaryLine).toBe("base changed automatically to main (old base feat)");
  });

  test("an unknown bot comment is collapsed, never hidden", () => {
    const view = derive({ items: [comment("some-new-bot", "2026-11-21T00:00:00Z", "hello", true)] });
    expect(view.section).toBe("hidden");
    expect(view.rounds[0]?.entries[0]).toMatchObject({ type: "group", group: { summary: "1 bot comment" } });
  });

  test("a PR someone else merged with no new human comments is hidden", () => {
    const merged = item("MergedEvent", "2026-11-21T00:00:00Z", { actor: user("bob"), commit: { oid: "x" } });
    const view = derive({ state: "MERGED", items: [merged] });
    expect(view.section).toBe("hidden");
    expect(view.reasons).toEqual(["closedByOthers"]);
    expect(view.hiddenStats.merged).toBe(1);
  });

  test("my PR being merged by someone else is a state change update", () => {
    const merged = item("MergedEvent", "2026-11-21T00:00:00Z", { actor: user("bob"), commit: { oid: "x" } });
    const view = derive({ author: ME, state: "MERGED", items: [merged] });
    expect(view.section).toBe("updates");
    expect(view.reasons).toEqual(["stateChange"]);
    expect(view.summaryLine).toBe("bob merged");
  });

  test("simple mode only counts mentions and human comments", () => {
    const review = item("PullRequestReview", "2026-11-21T00:00:00Z", {
      author: user("alice"),
      state: "APPROVED",
      submittedAt: "2026-11-21T00:00:00Z",
      body: "",
    });
    const merged = item("MergedEvent", "2026-11-21T01:00:00Z", { actor: user("alice"), commit: { oid: "x" } });
    expect(derive({ mode: "simple", ...DONE_MINE, items: [review, merged] }).section).toBe("hidden");
    const talk = comment("alice", "2026-11-21T02:00:00Z", "question");
    expect(derive({ mode: "simple", ...DONE_MINE, items: [review, merged, talk] }).reasons).toContain("onMine");
  });

  test("snooze overrides the section until it expires", () => {
    const items = [comment("alice", "2026-11-21T00:00:00Z", "@markerikson ping")];
    const snoozed = derive({ items, itemState: { snoozeUntil: "2026-11-23T00:00:00Z" } });
    expect(snoozed.section).toBe("snoozed");
    expect(snoozed.reasons).toEqual(["snoozed", "mentioned"]);
    expect(derive({ items, itemState: { snoozeUntil: "2026-11-21T12:00:00Z" } }).section).toBe("waiting");
  });

  test("muted subjects are hidden unless I am mentioned", () => {
    const quiet = derive({ items: [comment("alice", "2026-11-21T00:00:00Z", "nit")], itemState: { muted: true } });
    expect(quiet.section).toBe("hidden");
    expect(quiet.reasons).toContain("muted");
    const ping = derive({ items: [comment("alice", "2026-11-21T00:00:00Z", "@markerikson")], itemState: { muted: true } });
    expect(ping.section).toBe("waiting");
    expect(ping.reasons).toContain("muted");
  });

  test("a new issue with no comments is an update", () => {
    const labeled = item("LabeledEvent", "2026-11-21T00:00:00Z", { actor: user("bob"), label: { name: "bug" } });
    const view = derive({ kind: "issue", raw: { createdAt: "2026-11-21T00:00:00Z" }, items: [labeled] });
    expect(view.section).toBe("updates");
    expect(view.reasons).toEqual(["newIssue"]);
  });

  test("an old issue with only new label or reference activity stays hidden", () => {
    const labeled = item("LabeledEvent", "2026-11-21T00:00:00Z", { actor: user("bob"), label: { name: "bug" } });
    const view = derive({ kind: "issue", raw: { createdAt: "2026-11-01T00:00:00Z" }, items: [labeled] });
    expect(view.section).toBe("hidden");
  });

  test("assignment to me shows on issues but not on PRs", () => {
    const assigned = item("AssignedEvent", "2026-11-21T00:00:00Z", { actor: user("bob"), assignee: user(ME) });
    expect(derive({ kind: "issue", items: [assigned] }).reasons).toContain("assigned");
    expect(derive({ items: [assigned] }).section).toBe("hidden");
  });

  test("a review request on a merged PR is not waiting", () => {
    const raw = { reviewRequests: { nodes: [{ requestedReviewer: user(ME) }] } };
    expect(derive({ raw, state: "MERGED", items: [] }).reasons).not.toContain("reviewRequested");
  });

  test("agent notes posted under a human login are collapsed", () => {
    const note = comment("alice", "2026-11-21T00:00:00Z", "🤖 Done. Build is green.");
    expect(derive({ items: [note] }).section).toBe("hidden");
  });

  test("agent approve verdicts are hidden", () => {
    const verdict = comment("alice", "2026-11-21T00:00:00Z", "🤖 Approve: no issues found");
    const view = derive({ ...DONE_MINE, items: [verdict] });
    expect(view.section).toBe("hidden");
    expect(view.rounds[0]?.hiddenCount).toBe(1);
  });

  test("keep unread moves a hidden item to updates and marks it unread", () => {
    const view = derive({ itemState: { keepUnread: true } });
    expect(view.section).toBe("updates");
    expect(view.reasons).toEqual(["nothingNew", "keptUnread"]);
    expect(view.unread).toBe(true);
  });

  test("an unread thread counts as read once it is read locally", () => {
    expect(derive({}).unread).toBe(true);
    expect(derive({ itemState: { readAt: "2026-11-21T00:00:00Z" } }).unread).toBe(false);
    expect(derive({ enriched: false, itemState: { readAt: "2026-11-22T00:00:00Z" } }).unread).toBe(false);
  });

  test("a thread backfill dismissed without reading stays hidden but still shows unread", () => {
    const backfilled = { dismissedAt: "2026-11-21T00:00:00Z", readAt: null };
    const enriched = derive({ itemState: backfilled });
    expect(enriched.section).toBe("hidden");
    expect(enriched.unread).toBe(true);
    const unenriched = derive({ enriched: false, itemState: backfilled });
    expect(unenriched.section).toBe("hidden");
    expect(unenriched.unread).toBe(true);
  });

  test("snooze until a human event ignores bots and my own comments", () => {
    const itemState = { snoozeUntilHumanEvent: true, snoozedAt: "2026-11-20T12:00:00Z" };
    const botOnly = derive({ itemState, items: [comment("ci-bot", "2026-11-21T00:00:00Z", "green", true)] });
    expect(botOnly.section).toBe("snoozed");
    const mine = derive({ itemState, items: [comment(ME, "2026-11-21T00:00:00Z", "pushed a fix")] });
    expect(mine.section).toBe("snoozed");
    const before = derive({ itemState, items: [comment("alice", "2026-11-20T06:00:00Z", "older")] });
    expect(before.section).toBe("snoozed");
    const human = derive({ itemState, items: [comment("alice", "2026-11-21T00:00:00Z", "question")] });
    expect(human.section).toBe("updates");
  });

  test("snooze until ready wakes on ready for review, not on pushes", () => {
    const itemState = { snoozeUntilReady: true, snoozedAt: "2026-11-20T12:00:00Z" };
    const pushed = derive({ itemState, items: [forcePush("2026-11-21T00:00:00Z")] });
    expect(pushed.section).toBe("snoozed");
    const ready = item("ReadyForReviewEvent", "2026-11-21T01:00:00Z", { actor: user("bob") });
    expect(derive({ itemState, items: [ready] }).section).not.toBe("snoozed");
    const earlier = item("ReadyForReviewEvent", "2026-11-20T06:00:00Z", { actor: user("bob") });
    expect(derive({ itemState, items: [earlier] }).section).toBe("snoozed");
  });

  test("snooze with a time and a wake condition ends at whichever comes first", () => {
    const itemState = {
      snoozeUntilHumanEvent: true,
      snoozedAt: "2026-11-20T12:00:00Z",
      snoozeUntil: "2026-11-21T00:00:00Z",
    };
    expect(derive({ itemState }).section).not.toBe("snoozed");
  });

  test("a review request stays waiting after reading, but not after Done or my review", () => {
    const raw = { reviewRequests: { nodes: [{ requestedReviewer: user(ME) }] } };
    const request = item("ReviewRequestedEvent", "2026-11-19T00:00:00Z", {
      actor: user("bob"),
      requestedReviewer: user(ME),
    });
    const read = derive({ raw, items: [request], itemState: { dismissedAt: "2026-11-21T00:00:00Z" } });
    expect(read.reasons).toContain("reviewRequested");
    const done = derive({
      raw,
      items: [request],
      itemState: { dismissedAt: "2026-11-21T00:00:00Z", doneAt: "2026-11-21T00:00:00Z" },
    });
    expect(done.reasons).not.toContain("reviewRequested");
    const again = item("ReviewRequestedEvent", "2026-11-21T06:00:00Z", {
      actor: user("bob"),
      requestedReviewer: user(ME),
    });
    const rerequested = derive({
      raw,
      items: [request, again],
      itemState: { dismissedAt: "2026-11-21T00:00:00Z", doneAt: "2026-11-21T00:00:00Z" },
    });
    expect(rerequested.reasons).toContain("reviewRequested");
  });

  test("a PR closed by its author collapses unless I took part", () => {
    const closed = item("ClosedEvent", "2026-11-21T00:00:00Z", { actor: user("bob") });
    const view = derive({ state: "CLOSED", items: [closed] });
    expect(view.section).toBe("hidden");
    expect(view.reasons).toEqual(["closedByAuthor"]);

    const myComment = comment(ME, "2026-11-19T00:00:00Z", "thoughts");
    expect(derive({ state: "CLOSED", items: [myComment, closed] }).reasons).not.toContain("closedByAuthor");

    const byOther = item("ClosedEvent", "2026-11-21T00:00:00Z", { actor: user("alice") });
    expect(derive({ state: "CLOSED", items: [byOther] }).reasons).toEqual(["closedByOthers"]);
  });

  test("activity on my closed PR goes to updates unless it mentions me", () => {
    const merged = item("MergedEvent", "2026-11-20T12:00:00Z", { actor: user("bob"), commit: { oid: "x" } });
    const thanks = comment("alice", "2026-11-21T00:00:00Z", "thanks!");
    const view = derive({ author: ME, state: "MERGED", items: [merged, thanks] });
    expect(view.section).toBe("updates");
    expect(view.reasons).toContain("onMine");
    const ping = comment("alice", "2026-11-21T00:00:00Z", "@markerikson follow-up?");
    expect(derive({ author: ME, state: "MERGED", items: [merged, ping] }).section).toBe("waiting");
    const issue = derive({ kind: "issue", author: ME, state: "CLOSED", items: [thanks] });
    expect(issue.section).toBe("updates");
  });

  test("on a never-visited PR only the newest round is new", () => {
    const view = derive({
      itemState: { dismissedAt: null },
      items: [
        comment("alice", "2026-11-19T00:00:00Z", "first"),
        forcePush("2026-11-20T00:00:00Z"),
        comment("alice", "2026-11-20T01:00:00Z", "second"),
        forcePush("2026-11-21T00:00:00Z"),
        comment("alice", "2026-11-21T01:00:00Z", "third"),
      ],
    });
    expect(view.rounds.map((r) => r.isNew)).toEqual([true, false, false]);
    expect(view.newMeaningfulCount).toBe(1);
  });

  test("on a never-visited PR a mention in an older round still waits", () => {
    const view = derive({
      itemState: { dismissedAt: null },
      items: [
        comment("alice", "2026-11-19T00:00:00Z", "@markerikson thoughts?"),
        forcePush("2026-11-20T00:00:00Z"),
        comment("alice", "2026-11-20T01:00:00Z", "updated"),
      ],
    });
    expect(view.rounds.map((r) => r.isNew)).toEqual([true, false]);
    expect(view.section).toBe("waiting");
    expect(view.reasons).toContain("mentioned");
  });
});

describe("rounds", () => {
  test("commits within ten minutes form one push; consecutive push-only rounds merge", () => {
    const view = derive({
      items: [
        comment("alice", "2026-11-19T00:00:00Z", "first"),
        commit("2026-11-21T00:00:00Z"),
        commit("2026-11-21T00:05:00Z"),
        commit("2026-11-21T00:14:00Z"),
        comment("some-bot", "2026-11-21T00:20:00Z", "ci", true),
        comment("other-bot", "2026-11-21T00:21:00Z", "ci", true),
        comment("alice", "2026-11-21T00:30:00Z", "ok"),
        forcePush("2026-11-21T01:00:00Z"),
        commit("2026-11-21T03:00:00Z"),
      ],
    });
    const summary = view.rounds.map((r) => ({
      start: r.startLabel,
      commits: r.commits.length,
      entries: r.entries.map((e) => (e.type === "group" ? e.group.summary : e.event.kind)),
      isNew: r.isNew,
    }));
    expect(summary).toEqual([
      { start: "2 pushes, no other activity", commits: 1, entries: [], isNew: true },
      { start: "pushed 3 commits", commits: 3, entries: ["2 bot comments", "comment"], isNew: true },
      { start: null, commits: 0, entries: ["comment"], isNew: false },
    ]);
    expect(view.hiddenStats.pushes).toBe(3);
  });

  test("a round with visible activity breaks a run of push-only rounds", () => {
    const view = derive({
      items: [
        forcePush("2026-11-21T01:00:00Z"),
        forcePush("2026-11-21T02:00:00Z"),
        forcePush("2026-11-21T03:00:00Z"),
        comment("alice", "2026-11-21T03:30:00Z", "looks good"),
        forcePush("2026-11-21T04:00:00Z"),
        item("BaseRefForcePushedEvent", "2026-11-21T04:30:00Z", { actor: user("alice") }),
        forcePush("2026-11-21T05:00:00Z"),
      ],
    });
    expect(view.rounds.map((r) => [r.startLabel, r.pushCount])).toEqual([
      ["2 pushes", 2],
      ["force-pushed", 1],
      ["2 pushes, no other activity", 2],
    ]);
    expect(view.rounds[0]?.entries.map((e) => e.type)).toEqual(["group"]);
    expect(view.hiddenStats.pushes).toBe(5);
  });

  test("rebase-only and unchanged force-pushes join the current round instead of starting one", () => {
    const rebased = (onto: string | null): PushVerdict => ({ verdict: "rebase_only", reason: "patches equal", onto });
    const p1 = forcePush("2026-11-21T01:00:00Z", "p1");
    const said = comment("alice", "2026-11-21T01:30:00Z", "looks good");
    const p2 = forcePush("2026-11-21T02:00:00Z", "p2");
    const p3 = forcePush("2026-11-21T03:00:00Z", "p3");
    const p4 = forcePush("2026-11-21T04:00:00Z", "p4");
    const p5 = forcePush("2026-11-21T05:00:00Z", "p5");
    const view = derive({
      items: [p1, said, p2, p3, p4, p5],
      pushVerdicts: new Map<string, PushVerdict>([
        [p1.nodeId, { verdict: "changed", reason: "1 file differs", onto: null }],
        [p2.nodeId, rebased("master")],
        [p3.nodeId, rebased(null)],
        [p4.nodeId, { verdict: "noop", reason: "patches equal, same base", onto: null }],
        [p5.nodeId, { verdict: "pending", reason: null, onto: null }],
      ]),
    });
    expect(view.rounds.map((r) => [r.startLabel, r.pushCount])).toEqual([
      ["force-pushed", 1],
      ["force-pushed", 1],
    ]);
    expect(groupSummaries(view)).toEqual(["comment", "2 rebases, 1 unchanged re-push"]);
    expect(view.hiddenStats).toMatchObject({ pushes: 2, rebases: 3 });
  });

  test("a single rebase reads as where it landed", () => {
    const rebased: PushVerdict = { verdict: "rebase_only", reason: null, onto: "master" };
    const push = forcePush("2026-11-21T02:00:00Z", "p1");
    const view = derive({
      items: [comment("alice", "2026-11-21T01:00:00Z", "first"), push],
      pushVerdicts: new Map([[push.nodeId, rebased]]),
    });
    expect(groupSummaries(view)).toEqual(["comment", "rebased onto master"]);
    expect(view.summaryLine).toBe("alice commented: first");
    const only = forcePush("2026-11-21T02:00:00Z", "p1");
    const pushOnly = derive({ items: [only], pushVerdicts: new Map([[only.nodeId, rebased]]) });
    expect(pushOnly.summaryLine).toBe("bob rebased onto master");
  });

  test("a push back to an earlier SHA keeps its own verdict", () => {
    const rebase = forcePush("2026-11-21T01:00:00Z", "b");
    const change = forcePush("2026-11-21T02:00:00Z", "c");
    const revert = forcePush("2026-11-21T03:00:00Z", "b");
    const view = derive({
      items: [rebase, change, revert],
      pushVerdicts: new Map<string, PushVerdict>([
        [rebase.nodeId, { verdict: "rebase_only", reason: "patches equal", onto: null }],
        [change.nodeId, { verdict: "changed", reason: "1 file differs", onto: null }],
        [revert.nodeId, { verdict: "changed", reason: "1 file differs", onto: null }],
      ]),
    });
    expect(view.hiddenStats).toMatchObject({ pushes: 2, rebases: 1 });
  });

  const crossRef = (at: string, number: number, willClose = false, actor = "alice") =>
    item("CrossReferencedEvent", at, {
      actor: user(actor),
      willCloseTarget: willClose,
      source: { __typename: "PullRequest", number, title: `PR ${number}`, repository: { nameWithOwner: REPO } },
    });
  const groupSummaries = (view: ReturnType<typeof derive>) =>
    view.rounds.flatMap((r) => r.entries).map((e) => (e.type === "group" ? e.group.summary : e.event.kind));

  test("a run of cross-references gets its own group, apart from other collapsed events", () => {
    const view = derive({
      items: [
        rename("2026-11-21T00:00:00Z"),
        crossRef("2026-11-21T00:01:00Z", 2),
        crossRef("2026-11-21T00:02:00Z", 3),
        crossRef("2026-11-21T00:03:00Z", 4),
      ],
    });
    expect(groupSummaries(view)).toEqual(["1 rename", "alice referenced this from 3 PRs"]);
  });

  test("a cross-reference run by several people names them", () => {
    const run = (actors: string[]) =>
      groupSummaries(derive({ items: actors.map((a, i) => crossRef(`2026-11-21T00:0${i}:00Z`, i + 2, false, a)) }));
    expect(run(["alice", "bob", "alice"])).toEqual(["3 references from alice and bob"]);
    expect(run(["alice", "bob", "carol"])).toEqual(["3 references from alice, bob and 1 other"]);
    expect(run(["alice", "bob", "carol", "dave"])).toEqual(["4 references from alice, bob and 2 others"]);
  });

  test("the row summary of a cross-reference names who made it", () => {
    expect(derive({ items: [crossRef("2026-11-21T00:01:00Z", 2)] }).summaryLine).toBe(
      `alice referenced this in ${REPO}#2`,
    );
  });

  test("a single cross-reference stays in the surrounding group", () => {
    const view = derive({ items: [rename("2026-11-21T00:00:00Z"), crossRef("2026-11-21T00:01:00Z", 2)] });
    expect(groupSummaries(view)).toEqual(["1 rename, 1 cross-reference"]);
  });

  test("a cross-reference that will close this subject is shown on its own line", () => {
    const view = derive({
      items: [crossRef("2026-11-21T00:01:00Z", 2), crossRef("2026-11-21T00:02:00Z", 3, true), crossRef("2026-11-21T00:03:00Z", 4)],
    });
    expect(groupSummaries(view)).toEqual(["1 cross-reference", "crossReference", "1 cross-reference"]);
  });
});

describe("normalize", () => {
  test("subscription, branch deletion and deployment events are dropped", () => {
    const view = derive({
      items: [
        item("SubscribedEvent", "2026-11-21T00:00:00Z", { actor: user("bob") }),
        item("HeadRefDeletedEvent", "2026-11-21T00:01:00Z", {}),
        item("DeployedEvent", "2026-11-21T00:02:00Z", {}),
      ],
    });
    expect(view.rounds).toEqual([]);
  });

  test("milestone events get their own kind and label", () => {
    const view = derive({
      kind: "issue",
      items: [item("MilestonedEvent", "2026-11-21T00:00:00Z", { actor: user("bob"), milestoneTitle: "6.0" })],
    });
    const entry = view.rounds[0]?.entries[0];
    expect(entry).toMatchObject({ type: "group", group: { summary: "1 milestone change" } });
    expect(entry?.type === "group" && entry.group.items[0]?.data).toMatchObject({ milestone: "6.0", added: true });
  });
});

describe("summary line", () => {
  test("skips label and unknown events in favor of a describable one", () => {
    const view = derive({
      items: [
        rename("2026-11-19T00:00:00Z"),
        item("LabeledEvent", "2026-11-19T01:00:00Z", { actor: user("bob"), label: { name: "bug" } }),
        item("PinnedEvent", "2026-11-19T02:00:00Z", { actor: user("bob") }),
      ],
    });
    expect(view.summaryLine).toBe("bob renamed to b");
  });

  test("says who opened the subject when no event is describable", () => {
    const labeled = item("LabeledEvent", "2026-11-19T01:00:00Z", { actor: user("bob"), label: { name: "bug" } });
    expect(derive({ kind: "issue", author: "carol", items: [labeled] }).summaryLine).toBe("carol opened this issue");
    expect(derive({ author: "carol" }).summaryLine).toBe("carol opened this PR");
  });

  // tc39/ecma426#294: a new issue whose only activity is someone else adding a label.
  test("a new issue with only a new label says who opened it", () => {
    const view = derive({
      kind: "issue",
      author: "legendecas",
      raw: { createdAt: "2026-11-21T00:00:00Z" },
      items: [item("LabeledEvent", "2026-11-21T03:00:00Z", { actor: user("nicolo-ribaudo"), label: { name: "Proposal: Scopes" } })],
    });
    expect(view.summaryLine).toBe("legendecas opened this issue");
  });

  // reduxjs/redux-toolkit#5644: a new issue with no timeline items at all.
  test("a new issue with no timeline says who opened it", () => {
    const view = derive({ kind: "issue", author: "emersion", raw: { createdAt: "2026-11-21T00:00:00Z" } });
    expect(view.reasons).toContain("newIssue");
    expect(view.summaryLine).toBe("emersion opened this issue");
  });

  test("a new label after a new comment keeps the comment as the summary", () => {
    const view = derive({
      items: [
        comment("alice", "2026-11-21T00:00:00Z", "Looks good"),
        item("LabeledEvent", "2026-11-21T01:00:00Z", { actor: user("bob"), label: { name: "bug" } }),
      ],
    });
    expect(view.summaryLine).toBe("alice commented: Looks good");
  });

  test("a self-assignment reads as one", () => {
    const view = derive({
      kind: "issue",
      items: [item("AssignedEvent", "2026-11-21T00:00:00Z", { actor: user("Domiii"), assignee: user("Domiii") })],
    });
    expect(view.summaryLine).toBe("Domiii self-assigned");
  });
});

describe("description", () => {
  test("the view carries the stored description", () => {
    expect(derive({ raw: { body: "Fixes it" } }).body).toBe("Fixes it");
    expect(derive({}).body).toBeNull();
  });

  test.each([
    [{ body: "Fixes it" }, "Fixes it"],
    [{ body: "" }, null],
    [{ body: "  \n" }, null],
    [{ body: null }, null],
    [{ number: 1 }, undefined],
    [null, undefined],
    ["text", undefined],
  ])("subjectBody(%j)", (raw, expected) => {
    expect(subjectBody(raw)).toBe(expected);
  });
});

describe("review-bot findings", () => {
  const sticky = (at: string, head: string, sev = "should-fix"): StickyCommentVersion => ({
    commentNodeId: "IC1",
    bodyHash: `${at}-${sev}`,
    subjectKey: KEY,
    author: "github-actions",
    lastEditedAt: at,
    seenAt: at,
    lastSeenAt: at,
    body: [
      "### Review of `abc`",
      "- `src/a.ts`",
      `  - 🟠 **Should fix** Leaks a handle — [L3](https://x/blob/h/src/a.ts#L3) · _[1]_ <!-- ai-review kind=summary-item file=src/a.ts line=3 fp=abcdef0123 sev=${sev} -->`,
      `<!-- ai-review kind=summary pr=1 runs=1 head=${head} -->`,
    ].join("\n"),
  });
  const reviewedByMe = { latestReviews: { nodes: [{ author: user(ME) }] } };

  test("a new serious finding on a PR I reviewed is waiting", () => {
    const view = derive({ raw: reviewedByMe, headSha: "h1", stickies: [sticky("2026-11-21T02:00:00Z", "h1")] });
    expect(view.findings?.map((f) => [f.status, f.isNew])).toEqual([["outstanding", true]]);
    expect(view.reasons).toContain("newFindings");
    expect(view.section).toBe("waiting");
    expect(view.summaryLine).toBe("DiffLoupe found: Leaks a handle");
    expect(view.sortAt).toBe("2026-11-21T02:00:00Z");
  });

  test("findings seen before I dismissed the PR do not raise it again", () => {
    const view = derive({ raw: reviewedByMe, headSha: "h1", stickies: [sticky("2026-11-19T02:00:00Z", "h1")] });
    expect(view.findings?.[0]?.isNew).toBe(false);
    expect(view.reasons).not.toContain("newFindings");
  });

  test("minor findings are listed but do not raise the PR", () => {
    const view = derive({
      raw: reviewedByMe,
      headSha: "h1",
      stickies: [sticky("2026-11-21T02:00:00Z", "h1", "question")],
    });
    expect(view.findings).toHaveLength(1);
    expect(view.reasons).not.toContain("newFindings");
  });

  test("PRs I have no part in get no findings", () => {
    const view = derive({ headSha: "h1", stickies: [sticky("2026-11-21T02:00:00Z", "h1")] });
    expect(view.findings).toBeUndefined();
    expect(view.reasons).not.toContain("newFindings");
  });

  test("my own PR lists findings but waits through myOpenPr only", () => {
    const view = derive({ author: ME, headSha: "h1", stickies: [sticky("2026-11-21T02:00:00Z", "h1")] });
    expect(view.findings).toHaveLength(1);
    expect(view.reasons).toContain("myOpenPr");
    expect(view.reasons).not.toContain("newFindings");
  });
});
