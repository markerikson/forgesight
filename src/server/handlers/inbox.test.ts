import { describe, expect, test } from "bun:test";
import { entryKey, type InboxPayload, type Section, type SubjectView } from "../../core/index.ts";
import { toViewRecord } from "../../core/pipeline/row.ts";
import { DEFAULT_ITEM_STATE, putItemState } from "../../store/item-state.ts";
import { ensureSubjects, getSubject } from "../../store/subjects.ts";
import { upsertThreads } from "../../store/threads.ts";
import { putViews } from "../../store/views.ts";
import type { ServerCtx } from "../ctx.ts";
import { testCtx } from "../test-ctx.ts";
import { inboxHandler } from "./inbox.ts";
import { subjectHandler, subjectKeyFromPath } from "./subject.ts";

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

  function withRaw(raw: unknown): ServerCtx {
    const c = seeded();
    ensureSubjects(c.db, [{ subjectKey: "acme/app#1", repo: "acme/app", number: 1, kind: "pr", origin: "thread" }]);
    c.db.query("UPDATE subjects SET raw_json = ? WHERE subject_key = ?").run(JSON.stringify(raw), "acme/app#1");
    return c;
  }

  test("returns the PR description from the view", async () => {
    const c = withRaw({ number: 1, body: "Fixes **the** bug" });
    const { body } = await get(subjectHandler, "/api/subjects/acme/app/1", c);
    expect(body).toMatchObject({ key: "acme/app#1", body: "Fixes **the** bug" });
    expect(getSubject(c.db, "acme/app#1")?.dirtyAt).toBeNull();
  });

  test("queues a refetch when the stored fields predate the description", async () => {
    const c = withRaw({ number: 1 });
    await get(subjectHandler, "/api/subjects/acme/app/1", c);
    expect(getSubject(c.db, "acme/app#1")?.dirtyAt).toBe(NOW.toISOString());
  });

  test("does not queue a subject that has never been enriched", async () => {
    const c = seeded();
    ensureSubjects(c.db, [{ subjectKey: "acme/app#1", repo: "acme/app", number: 1, kind: "pr", origin: "thread" }]);
    await get(subjectHandler, "/api/subjects/acme/app/1", c);
    expect(getSubject(c.db, "acme/app#1")?.dirtyAt).toBeNull();
  });
});
