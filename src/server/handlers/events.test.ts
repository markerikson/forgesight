import { describe, expect, test } from "bun:test";
import { META } from "../../core/meta-keys.ts";
import { setMeta } from "../../store/meta.ts";
import { appendChange, pruneChanges } from "../../store/views.ts";
import { testCtx } from "../test-ctx.ts";
import { EventHub, PING_TICKS, STATUS_TICKS, eventStream } from "./events.ts";

const NOW = new Date("2026-11-24T12:00:00Z");
const T = NOW.toISOString();
const LATER = "2026-11-24T13:00:00Z";

interface SseEvent {
  event: string | null;
  id: string | null;
  data: unknown;
}

function parse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const out: SseEvent = { event: null, id: null, data: null };
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) out.event = line.slice(7);
        else if (line.startsWith("id: ")) out.id = line.slice(4);
        else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6));
        else if (line.startsWith(":")) out.event = "comment";
      }
      return out;
    });
}

function collector() {
  const chunks: string[] = [];
  return {
    client: { send: (text: string) => void chunks.push(text) },
    events: () => parse(chunks.join("")),
    take(): SseEvent[] {
      const out = parse(chunks.join(""));
      chunks.length = 0;
      return out;
    },
  };
}

function setup() {
  const ctx = testCtx(NOW);
  const hub = new EventHub(ctx, { autoTick: false });
  return { ctx, db: ctx.db, hub };
}

describe("EventHub", () => {
  test("opens with retry and the current seq, then the current status", () => {
    const { db, hub } = setup();
    appendChange(db, "view", "o/r#1", T);
    const fresh = new EventHub(hub.ctx, { autoTick: false });
    const c = collector();
    fresh.subscribe(c.client, null);
    const [first, status] = c.events();
    expect(first).toEqual({ event: null, id: "1", data: null });
    expect(status?.event).toBe("status");
  });

  test("sends changed only for view rows, with keys deduplicated", () => {
    const { db, hub } = setup();
    const c = collector();
    hub.subscribe(c.client, null);
    c.take();

    appendChange(db, "raw", "o/r#1", T);
    appendChange(db, "state", "o/r#1", T);
    hub.tick();
    expect(c.take()).toEqual([]);

    appendChange(db, "view", "o/r#1", T);
    appendChange(db, "raw", "o/r#2", T);
    appendChange(db, "view", "o/r#2", T);
    const last = appendChange(db, "view", "o/r#1", T);
    hub.tick();
    expect(c.take()).toEqual([
      { event: "changed", id: String(last), data: { seq: last, keys: ["o/r#1", "o/r#2"] } },
    ]);

    hub.tick();
    expect(c.take()).toEqual([]);
  });

  test("fans each change out to every stream", () => {
    const { db, hub } = setup();
    const a = collector();
    const b = collector();
    hub.subscribe(a.client, null);
    hub.subscribe(b.client, null);
    a.take();
    b.take();
    appendChange(db, "view", "o/r#1", T);
    hub.tick();
    expect(a.take().map((e) => e.event)).toEqual(["changed"]);
    expect(b.take().map((e) => e.event)).toEqual(["changed"]);
  });

  test("replays view changes after Last-Event-ID", () => {
    const { db, ctx } = setup();
    const seen = appendChange(db, "view", "o/r#1", T);
    appendChange(db, "state", "o/r#2", T);
    appendChange(db, "view", "o/r#2", T);
    const last = appendChange(db, "view", "o/r#3", T);
    const hub = new EventHub(ctx, { autoTick: false });

    const c = collector();
    hub.subscribe(c.client, String(seen));
    expect(c.events().filter((e) => e.event === "changed")).toEqual([
      { event: "changed", id: String(last), data: { seq: last, keys: ["o/r#2", "o/r#3"] } },
    ]);
  });

  test("sends nothing extra when Last-Event-ID is current", () => {
    const { db, ctx } = setup();
    const last = appendChange(db, "view", "o/r#1", T);
    const hub = new EventHub(ctx, { autoTick: false });
    const c = collector();
    hub.subscribe(c.client, String(last));
    expect(c.events().map((e) => e.event)).toEqual([null, "status"]);
  });

  test("sends reset when the feed was pruned past Last-Event-ID", () => {
    const { db, ctx } = setup();
    const seen = appendChange(db, "view", "o/r#1", T);
    appendChange(db, "view", "o/r#2", T);
    appendChange(db, "view", "o/r#3", LATER);
    pruneChanges(db, LATER);
    const hub = new EventHub(ctx, { autoTick: false });

    const c = collector();
    hub.subscribe(c.client, String(seen));
    expect(c.events().map((e) => e.event)).toEqual([null, "reset", "status"]);
  });

  test("sends reset when Last-Event-ID is ahead of the feed or not a number", () => {
    const { hub } = setup();
    for (const id of ["99", "abc"]) {
      const c = collector();
      hub.subscribe(c.client, id);
      expect(c.events().map((e) => e.event)).toContain("reset");
    }
  });

  test("sends status only when it changed, ignoring now", () => {
    const { db, hub } = setup();
    const c = collector();
    hub.subscribe(c.client, null);
    c.take();

    for (let i = 0; i < STATUS_TICKS; i++) hub.tick();
    expect(c.take()).toEqual([]);

    setMeta(db, META.workerStatus, "polling", T);
    for (let i = 0; i < STATUS_TICKS - 1; i++) hub.tick();
    expect(c.take()).toEqual([]);
    hub.tick();
    const [status] = c.take();
    expect(status?.event).toBe("status");
    expect(status?.data).toMatchObject({ worker: { status: "polling" } });

    for (let i = 0; i < STATUS_TICKS; i++) hub.tick();
    expect(c.take().filter((e) => e.event !== "comment")).toEqual([]);
  });

  test("pings on the keepalive interval", () => {
    const { hub } = setup();
    const c = collector();
    hub.subscribe(c.client, null);
    c.take();
    for (let i = 0; i < PING_TICKS; i++) hub.tick();
    expect(c.take().map((e) => e.event)).toEqual(["comment"]);
  });

  test("drops a stream whose send throws", () => {
    const { db, hub } = setup();
    let open = true;
    hub.subscribe(
      {
        send() {
          if (!open) throw new Error("closed");
        },
      },
      null,
    );
    expect(hub.size).toBe(1);
    open = false;
    appendChange(db, "view", "o/r#1", T);
    hub.tick();
    expect(hub.size).toBe(0);
  });
});

describe("eventStream", () => {
  test("streams SSE with the right headers and disables the idle timeout", async () => {
    const { hub } = setup();
    const timeouts: number[] = [];
    const req = Object.assign(new Request("http://localhost/api/events"), {
      runtime: { bun: { server: { timeout: (_req: Request, s: number) => void timeouts.push(s) } } },
    });
    const res = eventStream(req, hub);
    expect(timeouts).toEqual([0]);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toStartWith("retry: 3000\n");
    expect(hub.size).toBe(1);
    await reader?.cancel();
    expect(hub.size).toBe(0);
  });

  test("removes the stream when the request aborts", async () => {
    const { hub } = setup();
    const abort = new AbortController();
    const res = eventStream(
      new Request("http://localhost/api/events", { signal: abort.signal }),
      hub,
    );
    await res.body?.getReader().read();
    expect(hub.size).toBe(1);
    abort.abort();
    expect(hub.size).toBe(0);
  });

  test("passes Last-Event-ID through to replay", async () => {
    const { db, ctx } = setup();
    const seen = appendChange(db, "view", "o/r#1", T);
    appendChange(db, "view", "o/r#2", T);
    const hub = new EventHub(ctx, { autoTick: false });
    const res = eventStream(
      new Request("http://localhost/api/events", { headers: { "Last-Event-ID": String(seen) } }),
      hub,
    );
    const reader = res.body?.getReader();
    let text = "";
    while (!text.includes("event: changed")) {
      // oxlint-disable-next-line no-await-in-loop -- reads the stream chunk by chunk
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    expect(parse(text).find((e) => e.event === "changed")?.data).toEqual({
      seq: seen + 1,
      keys: ["o/r#2"],
    });
    await reader?.cancel();
  });
});
