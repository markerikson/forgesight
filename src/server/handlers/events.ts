import { changesAfter, latestChangeSeq, oldestChangeSeq } from "../../store/views.ts";
import type { ServerCtx } from "../ctx.ts";
import { readStatus } from "./status.ts";

export const TICK_MS = 1000;
/** Status is rebuilt every this many ticks. */
export const STATUS_TICKS = 5;
/** A comment line is sent every this many ticks so proxies keep the stream open. */
export const PING_TICKS = 15;
export const RETRY_MS = 3000;

/** One open event stream. `send` throws once the stream is closed. */
export interface EventClient {
  send(text: string): void;
  /** Ends the stream so the browser reconnects. */
  close(): void;
}

interface Subscriber {
  client: EventClient;
  statusKey: string | null;
}

function changedEvent(seq: number, keys: string[]): string {
  return `event: changed\nid: ${seq}\ndata: ${JSON.stringify({ seq, keys })}\n\n`;
}

function statusEvent(status: object): string {
  return `event: status\ndata: ${JSON.stringify(status)}\n\n`;
}

/** Status compared without `now` and the spend window start, which move on every read. */
function statusKey(status: ReturnType<typeof readStatus>): string {
  return JSON.stringify({ ...status, now: null, spend: { ...status.spend, since: null } });
}

/** `view` changes after `after` as the max seq read plus the distinct subject keys. */
function viewChanges(ctx: ServerCtx, after: number): { seq: number; keys: string[] } | null {
  const changes = changesAfter(ctx.db, after);
  const last = changes.at(-1);
  if (!last) return null;
  const keys = new Set<string>();
  for (const c of changes) {
    if (c.kind === "view" && c.subjectKey) keys.add(c.subjectKey);
  }
  return { seq: last.seq, keys: [...keys] };
}

/**
 * Reads the change feed once per tick on the read-only connection and fans `view` changes
 * out to every open stream. The timer runs only while at least one stream is open.
 */
export class EventHub {
  readonly ctx: ServerCtx;
  private readonly subscribers = new Set<Subscriber>();
  private cursor: number;
  private ticks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly autoTick: boolean;

  constructor(ctx: ServerCtx, opts: { autoTick?: boolean } = {}) {
    this.ctx = ctx;
    this.cursor = latestChangeSeq(ctx.db);
    this.autoTick = opts.autoTick ?? true;
  }

  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Adds a stream. With a `lastEventId`, view changes after it are replayed, or `reset` is
   * sent when the feed was pruned past it. Returns the function that removes the stream.
   */
  subscribe(client: EventClient, lastEventId: string | null): () => void {
    const sub: Subscriber = { client, statusKey: null };
    // While no stream was open nothing advanced the cursor; catch up before replaying.
    if (this.subscribers.size === 0) this.cursor = latestChangeSeq(this.ctx.db);
    this.subscribers.add(sub);
    const remove = () => this.remove(sub);
    try {
      client.send(`retry: ${RETRY_MS}\nid: ${this.cursor}\n\n`);
      this.replay(sub, lastEventId);
      this.sendStatus(sub, readStatus(this.ctx));
    } catch {
      remove();
      return remove;
    }
    if (this.autoTick && !this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    return remove;
  }

  tick(): void {
    this.ticks++;
    try {
      const batch = viewChanges(this.ctx, this.cursor);
      if (batch) {
        this.cursor = batch.seq;
        if (batch.keys.length > 0) this.broadcast(changedEvent(batch.seq, batch.keys));
      }
      if (this.ticks % STATUS_TICKS === 0) {
        const status = readStatus(this.ctx);
        for (const sub of [...this.subscribers]) this.deliver(sub, () => this.sendStatus(sub, status));
      }
    } catch (err) {
      // The connection was closed or the schema changed: drop every stream so clients
      // reconnect against a fresh context.
      console.warn("[events] tick failed:", err);
      this.close();
      return;
    }
    if (this.ticks % PING_TICKS === 0) this.broadcast(": ping\n\n");
  }

  /** Ends every stream and stops the timer. */
  close(): void {
    for (const sub of [...this.subscribers]) {
      this.remove(sub);
      try {
        sub.client.close();
      } catch {
        // already closed
      }
    }
  }

  private replay(sub: Subscriber, lastEventId: string | null): void {
    if (lastEventId === null || lastEventId.trim() === "") return;
    const from = Number(lastEventId);
    if (!Number.isInteger(from) || from < 0 || from > this.cursor) {
      sub.client.send("event: reset\ndata: {}\n\n");
      return;
    }
    if (from === this.cursor) return;
    const oldest = oldestChangeSeq(this.ctx.db);
    if (oldest === null || from + 1 < oldest) {
      sub.client.send("event: reset\ndata: {}\n\n");
      return;
    }
    const keys = new Set<string>();
    for (const c of changesAfter(this.ctx.db, from)) {
      if (c.seq <= this.cursor && c.kind === "view" && c.subjectKey) keys.add(c.subjectKey);
    }
    if (keys.size > 0) sub.client.send(changedEvent(this.cursor, [...keys]));
  }

  private sendStatus(sub: Subscriber, status: ReturnType<typeof readStatus>): void {
    const key = statusKey(status);
    if (key === sub.statusKey) return;
    sub.client.send(statusEvent(status));
    sub.statusKey = key;
  }

  private broadcast(text: string): void {
    for (const sub of [...this.subscribers]) this.deliver(sub, () => sub.client.send(text));
  }

  private deliver(sub: Subscriber, send: () => void): void {
    try {
      send();
    } catch {
      this.remove(sub);
    }
  }

  private remove(sub: Subscriber): void {
    this.subscribers.delete(sub);
    if (this.subscribers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

let hub: EventHub | null = null;

/** The process-wide hub for `ctx`. A new context (after a schema change) gets a new hub. */
export function hubFor(ctx: ServerCtx): EventHub {
  if (!hub || hub.ctx !== ctx) {
    hub?.close();
    hub = new EventHub(ctx);
  }
  return hub;
}

type BunServerLike = { timeout(req: Request, seconds: number): void };
type SrvxRequest = Request & { runtime?: { bun?: { server?: BunServerLike } } };

/** Opens an SSE stream on `hub` for `req`. */
export function eventStream(req: Request, hub: EventHub): Response {
  // Bun closes idle requests after 10s by default; SSE streams stay open.
  (req as SrvxRequest).runtime?.bun?.server?.timeout(req, 0);
  const enc = new TextEncoder();
  let remove: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      remove = hub.subscribe(
        { send: (text) => controller.enqueue(enc.encode(text)), close },
        req.headers.get("last-event-id"),
      );
      req.signal.addEventListener("abort", () => {
        remove?.();
        close();
      });
    },
    cancel() {
      remove?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function eventsHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  return eventStream(req, hubFor(ctx));
}
