import { describe, expect, test } from "bun:test";
import { parseConfigText, resolveConfig } from "../../config/load.ts";
import { ENRICH_PRIORITY } from "../../core/enrich-plan.ts";
import { entryKey, type InboxPayload, type Section, type SubjectDetail, type SubjectView } from "../../core/index.ts";
import { openPullsMetaKey } from "../../core/meta-keys.ts";
import { toViewRecord } from "../../core/pipeline/row.ts";
import type { OpenPull, OpenPullsListing } from "../../github/queries/open-pulls.ts";
import { setMeta } from "../../store/meta.ts";
import { rebuildWorkstreams } from "../../worker/workstreams.ts";
import { DEFAULT_ITEM_STATE, putItemState } from "../../store/item-state.ts";
import { ensureSubjects, getSubject, markDirty, recordNotFound } from "../../store/subjects.ts";
import { upsertThreads } from "../../store/threads.ts";
import { putViews } from "../../store/views.ts";
import type { ServerCtx } from "../ctx.ts";
import { testCtx } from "../test-ctx.ts";
import { inboxHandler } from "./inbox.ts";
import { refreshSubjectHandler, subjectHandler, subjectKeyFromPath } from "./subject.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");

function ctx(): ServerCtx {
  return testCtx(NOW);
}

function view(key: string, section: Section, number: number | null): SubjectView {
  return {
    key,
    header: {
      key,
      repo: "acme/app",
      number,
      kind: number === null ? "other" : "pr",
      title: key,
      url: number === null ? null : `https://github.com/acme/app/pull/${number}`,
      author: null,
      authorIsBot: false,
      state: null,
      draft: false,
      merged: false,
      headRef: null,
      baseRef: null,
      ciState: null,
      reviewDecision: null,
      latestHumanActor: null,
      labels: [],
      enrichError: null,
    },
    rounds: [],
    lastVisitAt: null,
    body: number === 1 ? "Fixes **the** bug" : null,
    links: [],
    section,
    reasons: [],
    score: 0,
    newMeaningfulCount: 0,
    summaryLine: "",
    hiddenStats: { pushes: 1, merged: 0, closed: 0 },
    sortAt: "2026-11-01T00:00:00Z",
    snoozeUntil: null,
    unread: false,
  };
}

function seeded(): ServerCtx {
  const c = ctx();
  const meta = { pipelineVersion: 1, configHash: "h", computedAt: NOW.toISOString() };
  putViews(
    c.db,
    [
      toViewRecord(view("acme/app#1", "waiting", 1), meta),
      toViewRecord(view("acme/app#2", "hidden", 2), meta),
      toViewRecord(view("acme/app@t9", "updates", null), meta),
    ],
    NOW.toISOString(),
  );
  upsertThreads(
    c.db,
    [
      {
        threadId: "t9",
        subjectKey: "acme/app@t9",
        repo: "acme/app",
        subjectType: "Release",
        reason: "subscribed",
        unread: true,
        updatedAt: "2026-11-01T00:00:00Z",
        lastReadAt: null,
        subjectUrl: "https://api.github.com/repos/acme/app/releases/5",
        raw: {},
      },
    ],
    NOW.toISOString(),
  );
  return c;
}

async function get(handler: typeof inboxHandler, path: string, c: ServerCtx) {
  const res = await handler(new Request(`http://127.0.0.1:4630${path}`), c);
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("inboxHandler", () => {
  test("returns active rows and counts hidden ones", async () => {
    const { status, body } = await get(inboxHandler, "/api/inbox", seeded());
    const payload = body as InboxPayload;
    expect(status).toBe(200);
    expect(payload.rows.map(entryKey)).toEqual(["acme/app#1", "acme/app@t9"]);
    expect(payload.sidebar.sections.hidden).toBe(1);
    expect(payload.countLines).toEqual(["app: 1 pushed"]);
  });

  test("includes hidden rows with includeHidden=1", async () => {
    const { body } = await get(inboxHandler, "/api/inbox?includeHidden=1", seeded());
    expect((body as InboxPayload).rows.map(entryKey)).toContain("acme/app#2");
  });

  test("leaves out a Hidden row marked Done with nothing newer, from the list and the counts", async () => {
    const c = seeded();
    putItemState(c.db, "acme/app#2", { ...DEFAULT_ITEM_STATE, doneAt: "2026-11-02T00:00:00.000Z" }, NOW.toISOString());
    const closed = (await get(inboxHandler, "/api/inbox", c)).body as InboxPayload;
    expect(closed.sidebar.sections.hidden).toBe(0);
    expect(closed.countLines).toEqual([]);
    const open = (await get(inboxHandler, "/api/inbox?includeHidden=1", c)).body as InboxPayload;
    expect(open.rows.map(entryKey)).not.toContain("acme/app#2");
  });

  test("lists a Done Hidden row again once it has newer activity", async () => {
    const c = seeded();
    putItemState(c.db, "acme/app#2", { ...DEFAULT_ITEM_STATE, doneAt: "2026-10-30T00:00:00.000Z" }, NOW.toISOString());
    const payload = (await get(inboxHandler, "/api/inbox?includeHidden=1", c)).body as InboxPayload;
    expect(payload.rows.map(entryKey)).toContain("acme/app#2");
    expect(payload.sidebar.sections.hidden).toBe(1);
  });

  test("returns an empty inbox before the worker has derived anything", async () => {
    const { body } = await get(inboxHandler, "/api/inbox", ctx());
    expect((body as InboxPayload).rows).toEqual([]);
  });
});

describe("subjectKeyFromPath", () => {
  test.each([
    ["/api/subjects/acme/app/12", "acme/app#12"],
    ["/api/subjects/acme/app/12/", "acme/app#12"],
    ["/api/subjects/acme/app/%40t9", "acme/app@t9"],
    ["/api/subjects/acme/app/abc", null],
    ["/api/subjects/acme/app", null],
    ["/api/subjects/acme/app/%E0%A4%A", null],
  ])("%s", (path, expected) => {
    expect(subjectKeyFromPath(path)).toBe(expected);
  });
});

describe("subjectHandler", () => {
  test("returns the stored view with reason and GitHub URL", async () => {
    const { status, body } = await get(subjectHandler, "/api/subjects/acme/app/%40t9", seeded());
    expect(status).toBe(200);
    expect(body).toMatchObject({
      key: "acme/app@t9",
      reason: "subscribed",
      githubUrl: "https://github.com/acme/app/releases",
    });
  });

  test("404s for a subject without a view", async () => {
    const { status } = await get(subjectHandler, "/api/subjects/acme/app/99", seeded());
    expect(status).toBe(404);
  });

  test("400s for a path that is not a subject", async () => {
    const { status } = await get(subjectHandler, "/api/subjects/acme/app/abc", seeded());
    expect(status).toBe(400);
  });

  const FETCHED_AT = "2026-11-20T00:00:00.000Z";

  function subject(c: ServerCtx, kind: "pr" | "issue" = "pr"): ServerCtx {
    ensureSubjects(c.db, [{ subjectKey: "acme/app#1", repo: "acme/app", number: 1, kind, origin: "thread" }]);
    return c;
  }

  function withRaw(raw: unknown): ServerCtx {
    const c = subject(seeded());
    c.db
      .query("UPDATE subjects SET raw_json = ?, timeline_synced_until = ? WHERE subject_key = ?")
      .run(JSON.stringify(raw), FETCHED_AT, "acme/app#1");
    return c;
  }

  function notification(c: ServerCtx, updatedAt: string): void {
    upsertThreads(
      c.db,
      [
        {
          threadId: "t1",
          subjectKey: "acme/app#1",
          repo: "acme/app",
          subjectType: "PullRequest",
          reason: "subscribed",
          unread: true,
          updatedAt,
          lastReadAt: null,
          subjectUrl: "https://api.github.com/repos/acme/app/pulls/1",
          raw: {},
        },
      ],
      NOW.toISOString(),
    );
  }

  const queued = (c: ServerCtx) => {
    const s = getSubject(c.db, "acme/app#1");
    return { dirtyAt: s?.dirtyAt, priority: s?.priority };
  };
  const URGENT = { dirtyAt: NOW.toISOString(), priority: ENRICH_PRIORITY.urgent };

  async function open(c: ServerCtx) {
    const { body } = await get(subjectHandler, "/api/subjects/acme/app/1", c);
    const res = await refreshSubjectHandler(
      new Request("http://127.0.0.1:4630/api/subjects/acme/app/1/refresh?ifNeeded=1", { method: "POST" }),
      c,
    );
    return { body, opened: { status: res.status, body: (await res.json()) as unknown } };
  }

  test("returns the PR description from the view without queueing a current subject", async () => {
    const c = withRaw({ number: 1, body: "Fixes **the** bug" });
    notification(c, "2026-11-19T00:00:00.000Z");
    const { body, opened } = await open(c);
    expect(body).toMatchObject({ key: "acme/app#1", body: "Fixes **the** bug", refreshable: true, fetching: false });
    expect(opened).toEqual({ status: 200, body: { key: "acme/app#1", fetching: false } });
    expect(getSubject(c.db, "acme/app#1")?.dirtyAt).toBeNull();
  });

  test("reading a subject never queues it, so list prefetches stay out of the queue", async () => {
    const c = subject(seeded());
    const { body } = await get(subjectHandler, "/api/subjects/acme/app/1", c);
    expect(body).toMatchObject({ refreshable: true, fetching: true });
    expect(getSubject(c.db, "acme/app#1")?.dirtyAt).toBeNull();
  });

  test("queues an urgent fetch when the stored fields predate the description", async () => {
    const c = withRaw({ number: 1 });
    const { body, opened } = await open(c);
    expect(body).toMatchObject({ fetching: true });
    expect(opened).toEqual({ status: 202, body: { key: "acme/app#1", fetching: true } });
    expect(queued(c)).toEqual(URGENT);
  });

  test("queues an urgent fetch for a subject that has never been fetched", async () => {
    const c = subject(seeded());
    await open(c);
    expect(queued(c)).toEqual(URGENT);
  });

  test("queues an urgent fetch when a notification is newer than the last fetch", async () => {
    const c = withRaw({ number: 1, body: "Fixes **the** bug" });
    notification(c, "2026-11-21T00:00:00.000Z");
    await open(c);
    expect(queued(c)).toEqual(URGENT);
  });

  test("moves an already queued subject to the front of the queue", async () => {
    const c = withRaw({ number: 1, body: "Fixes **the** bug" });
    markDirty(c.db, ["acme/app#1"], "2026-11-23T00:00:00.000Z");
    const { body } = await open(c);
    expect(body).toMatchObject({ fetching: true });
    expect(queued(c)).toEqual({ dirtyAt: "2026-11-23T00:00:00.000Z", priority: ENRICH_PRIORITY.urgent });
  });

  test("does not queue a subject whose last fetch failed", async () => {
    const c = withRaw({ number: 1 });
    recordNotFound(c.db, "acme/app#1");
    const { body, opened } = await open(c);
    expect(body).toMatchObject({ refreshable: true, fetching: false });
    expect(opened.status).toBe(200);
    expect(getSubject(c.db, "acme/app#1")?.dirtyAt).toBeNull();
  });

  test("does not queue an issue when issues are not fetched", async () => {
    const c = subject(testCtx(NOW, { config: parseConfigText(`{ "polling": { "enrichIssues": false } }`) }), "issue");
    putViews(
      c.db,
      [toViewRecord(view("acme/app#1", "waiting", 1), { pipelineVersion: 1, configHash: "h", computedAt: NOW.toISOString() })],
      NOW.toISOString(),
    );
    const { body } = await get(subjectHandler, "/api/subjects/acme/app/1", c);
    expect(body).toMatchObject({ refreshable: false, fetching: false });
    expect(getSubject(c.db, "acme/app#1")?.dirtyAt).toBeNull();
  });

  test("names stack members with no view from the open-PR listing", async () => {
    const c = seeded();
    const pull = (number: number, baseRef: string, title: string): OpenPull => ({
      number,
      title,
      author: "alice",
      authorType: "User",
      headRef: `b${number}`,
      baseRef,
      headSha: `sha${number}`,
      updatedAt: "2026-11-24T10:00:00Z",
      isDraft: false,
    });
    const listing: OpenPullsListing = {
      repo: "acme/app",
      fetchedAt: NOW.toISOString(),
      pulls: [pull(1, "main", "First part"), pull(3, "b1", "Third part")],
    };
    setMeta(c.db, openPullsMetaKey("acme/app"), JSON.stringify(listing), NOW.toISOString());
    const config = resolveConfig({ me: "mark", repos: { "acme/app": { view: "overview" } } });
    rebuildWorkstreams(c.db, config, "acme/app", NOW);
    const { body } = await get(subjectHandler, "/api/subjects/acme/app/1", c);
    const workstream = (body as SubjectDetail).workstream;
    expect(workstream?.stack.children).toEqual(["acme/app#3"]);
    expect(workstream?.titles["acme/app#3"]).toBe("Third part");
  });
});

describe("refreshSubjectHandler", () => {
  async function post(path: string, c: ServerCtx) {
    const res = await refreshSubjectHandler(new Request(`http://127.0.0.1:4630${path}`, { method: "POST" }), c);
    return { status: res.status, body: (await res.json()) as unknown };
  }

  test("queues an urgent fetch even after a failed fetch", async () => {
    const c = seeded();
    ensureSubjects(c.db, [{ subjectKey: "acme/app#1", repo: "acme/app", number: 1, kind: "pr", origin: "thread" }]);
    recordNotFound(c.db, "acme/app#1");
    const { status, body } = await post("/api/subjects/acme/app/1/refresh", c);
    expect(status).toBe(202);
    expect(body).toEqual({ key: "acme/app#1", fetching: true });
    const s = getSubject(c.db, "acme/app#1");
    expect({ dirtyAt: s?.dirtyAt, priority: s?.priority }).toEqual({
      dirtyAt: NOW.toISOString(),
      priority: ENRICH_PRIORITY.urgent,
    });
  });

  test("404s for an unknown subject and 400s for a bad path", async () => {
    expect((await post("/api/subjects/acme/app/99/refresh", seeded())).status).toBe(404);
    expect((await post("/api/subjects/acme/app/abc/refresh", seeded())).status).toBe(400);
  });
});
