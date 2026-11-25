import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type InboxRow, entryKey } from "../../core/index.ts";
import { api } from "./api.ts";
import { row, storeWith } from "./__fixtures__/inbox.ts";
import { applyState, undoLatest } from "./state-api.ts";
import { rowRead, rowSelected, selectSelectedRow, selectVisibleRows } from "./view.ts";

type Reply = { status: number; body: unknown; delayMs?: number };

const RealRequest = globalThis.Request;
const realFetch = globalThis.fetch;
let replies: Reply[] = [];
let sent: { url: string; body: unknown }[] = [];

/** The client uses relative URLs; resolve them against a dummy origin so Request accepts them. */
class LocalRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/") ? `http://localhost${input}` : input, init);
  }
}

beforeEach(() => {
  replies = [];
  sent = [];
  globalThis.Request = LocalRequest as typeof Request;
  globalThis.fetch = (async (input: Request) => {
    sent.push({ url: new URL(input.url).pathname, body: await input.json() });
    const reply = replies.shift() ?? { status: 500, body: {} };
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.Request = RealRequest;
  globalThis.fetch = realFetch;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const rows = [row("acme/app#1", "waiting"), row("acme/app#2", "waiting"), row("acme/app#3", "waiting")];

function cached(store: ReturnType<typeof storeWith>) {
  return api.endpoints.getInbox.select({ includeHidden: false })(store.getState()).data!;
}

describe("applyState", () => {
  test("removes done rows at once, moves the selection, and records the undo", async () => {
    const store = storeWith(rows);
    store.dispatch(rowSelected({ key: "acme/app#2", index: 1 }));
    const doneRow: InboxRow = { ...rows[1]!, section: "hidden" };
    replies.push({ status: 200, body: { opId: 1, outboxIds: [1], rows: { "acme/app#2": doneRow } } });

    store.dispatch(applyState(["acme/app#2"], { kind: "done" }));
    expect(selectVisibleRows(store.getState()).map(entryKey)).toEqual(["acme/app#1", "acme/app#3"]);
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#3");

    await settle();
    expect(sent).toEqual([{ url: "/api/state", body: { keys: ["acme/app#2"], op: { kind: "done" } } }]);
    expect(cached(store).sidebar.sections).toMatchObject({ waiting: 2, hidden: 1 });
    expect(store.getState().view.undo).toMatchObject([{ opId: 1, label: "Done", keys: ["acme/app#2"] }]);
    expect(store.getState().view.toast).toMatchObject({ message: "Done", opId: 1 });
  });

  test("restores the rows and shows an error when the server refuses", async () => {
    const store = storeWith(rows);
    replies.push({ status: 500, body: { error: "boom" } });

    store.dispatch(applyState(["acme/app#1"], { kind: "mute" }));
    expect(selectVisibleRows(store.getState())).toHaveLength(2);

    await settle();
    expect(selectVisibleRows(store.getState())).toHaveLength(3);
    expect(store.getState().view.undo).toEqual([]);
    expect(store.getState().view.toast).toMatchObject({ kind: "error", message: "Could not save: Muted" });
  });

  test("a refused change keeps another change that succeeded meanwhile", async () => {
    const store = storeWith(rows);
    const doneRow: InboxRow = { ...rows[1]!, section: "hidden" };
    replies.push({ status: 500, body: { error: "boom" }, delayMs: 20 });
    replies.push({ status: 200, body: { opId: 3, outboxIds: [3], rows: { "acme/app#2": doneRow } } });

    store.dispatch(applyState(["acme/app#1"], { kind: "mute" }));
    store.dispatch(applyState(["acme/app#2"], { kind: "done" }));
    expect(selectVisibleRows(store.getState()).map(entryKey)).toEqual(["acme/app#3"]);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(selectVisibleRows(store.getState()).map(entryKey)).toEqual(["acme/app#1", "acme/app#3"]);
    expect(cached(store).sidebar.sections).toMatchObject({ waiting: 2, hidden: 1 });
  });

  test("a refused Done brings back the read row it took out of the list", async () => {
    const store = storeWith(rows);
    const readRow: InboxRow = { ...rows[0]!, unread: false };
    store.dispatch(rowRead(readRow));
    replies.push({ status: 500, body: { error: "boom" } });

    store.dispatch(applyState(["acme/app#1"], { kind: "done" }));
    expect(store.getState().view.lingering).toEqual([]);

    await settle();
    expect(store.getState().view.lingering).toEqual([readRow]);
  });

  test("marking read records no undo and shows no toast", async () => {
    const store = storeWith([row("acme/app#1", "updates", "acme/app", { unread: true, newMeaningfulCount: 2 })]);
    replies.push({ status: 200, body: { opId: 2, outboxIds: [], rows: {} } });

    store.dispatch(applyState(["acme/app#1"], { kind: "read" }));
    expect(cached(store).rows[0]).toMatchObject({ unread: false, newMeaningfulCount: 0 });

    await settle();
    expect(store.getState().view.undo).toEqual([]);
    expect(store.getState().view.toast).toBeNull();
  });
});

describe("undoLatest", () => {
  test("puts the server's rows back and drops the undo entry", async () => {
    const store = storeWith(rows);
    replies.push(
      { status: 200, body: { opId: 1, outboxIds: [], rows: { "acme/app#1": { ...rows[0]!, section: "hidden" } } } },
      { status: 200, body: { result: "undone", githubApplied: 0, rows: { "acme/app#1": rows[0] } } },
    );
    store.dispatch(applyState(["acme/app#1"], { kind: "done" }));
    await settle();

    store.dispatch(undoLatest());
    await settle();
    expect(sent[1]).toEqual({ url: "/api/state/undo", body: { opId: 1 } });
    expect(selectVisibleRows(store.getState())).toHaveLength(3);
    expect(cached(store).sidebar.sections).toMatchObject({ waiting: 3, hidden: 0 });
    expect(store.getState().view.undo).toEqual([]);
    expect(store.getState().view.toast?.message).toBe("Undone: Done");
  });

  test("names the change GitHub already applied", async () => {
    const store = storeWith(rows);
    replies.push(
      { status: 200, body: { opId: 1, outboxIds: [1], rows: {} } },
      { status: 200, body: { result: "undone", githubApplied: 1, rows: {} } },
    );
    store.dispatch(applyState(["acme/app#1"], { kind: "unsubscribe" }));
    await settle();

    store.dispatch(undoLatest());
    await settle();
    expect(store.getState().view.toast?.message).toBe("Undone here. GitHub already applied: Muted and unsubscribed");
  });

  test("brings back a read row that Done took out of the list", async () => {
    const store = storeWith(rows);
    const readRow: InboxRow = { ...rows[0]!, unread: false };
    const hiddenRow: InboxRow = { ...readRow, section: "hidden" };
    store.dispatch(rowRead(readRow));
    replies.push(
      { status: 200, body: { opId: 1, outboxIds: [], rows: { "acme/app#1": hiddenRow } } },
      { status: 200, body: { result: "undone", githubApplied: 0, rows: { "acme/app#1": hiddenRow } } },
    );
    store.dispatch(applyState(["acme/app#1"], { kind: "done" }));
    await settle();
    expect(store.getState().view.lingering).toEqual([]);

    store.dispatch(undoLatest());
    await settle();
    expect(store.getState().view.lingering).toEqual([readRow]);
    expect(selectVisibleRows(store.getState()).map(entryKey)).toContain("acme/app#1");
  });

  test("a superseded undo explains why and drops the entry", async () => {
    const store = storeWith(rows);
    replies.push(
      { status: 200, body: { opId: 1, outboxIds: [], rows: {} } },
      { status: 409, body: { result: "superseded" } },
    );
    store.dispatch(applyState(["acme/app#1"], { kind: "done" }));
    await settle();

    store.dispatch(undoLatest());
    await settle();
    expect(store.getState().view.undo).toEqual([]);
    expect(store.getState().view.toast).toMatchObject({
      kind: "error",
      message: "A newer change on this item; undo that first",
    });
  });

  test("says so when there is nothing to undo", () => {
    const store = storeWith(rows);
    store.dispatch(undoLatest());
    expect(store.getState().view.toast?.message).toBe("Nothing to undo");
    expect(sent).toEqual([]);
  });
});
