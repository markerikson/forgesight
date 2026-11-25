import type { StatusPayload } from "../../server/handlers/status.ts";
import { api } from "./api.ts";
import type { AppStore } from "./index.ts";
import { connectionChanged } from "./view.ts";

/** Changed keys arriving within this window refetch together. */
export const CHANGE_BATCH_MS = 250;
/** Wait before opening a new stream after the browser gave up on one. */
const RECONNECT_MS = 5_000;

interface ChangedEvent {
  seq: number;
  keys: string[];
  /** Workstreams whose membership, name or state changed. */
  workstreams?: string[];
}

function parse<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(String(event.data)) as T;
  } catch {
    return null;
  }
}

/** Opens the live-update stream for this tab. Returns a function that closes it. */
export function startEvents(store: AppStore): () => void {
  if (typeof EventSource === "undefined") return () => {};
  let source: EventSource | null = null;
  let stopped = false;
  let opened = false;
  let pending = new Set<string>();
  let pendingWorkstreams = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    const keys = [...pending];
    const workstreams = [...pendingWorkstreams];
    pending = new Set();
    pendingWorkstreams = new Set();
    // The inbox list carries the workstream groups, so the LIST tag refreshes them too.
    store.dispatch(
      api.util.invalidateTags([
        { type: "Inbox", id: "LIST" },
        ...keys.map((key) => ({ type: "Subject" as const, id: key })),
        ...workstreams.map((id) => ({ type: "Workstream" as const, id })),
      ]),
    );
  };

  const connect = () => {
    store.dispatch(connectionChanged("connecting"));
    const es = new EventSource("/api/events");
    source = es;
    es.onopen = () => {
      store.dispatch(connectionChanged("open"));
      // A new stream starts without the last event id, so nothing is replayed: not the changes
      // since the server render on the first open, nor the changes while it was down later.
      store.dispatch(
        api.util.invalidateTags(opened ? ["Inbox", "Subject", "Workstream", "Status"] : [{ type: "Inbox", id: "LIST" }, "Status"]),
      );
      opened = true;
    };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) {
        store.dispatch(connectionChanged("connecting"));
        return;
      }
      store.dispatch(connectionChanged("closed"));
      if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    };
    es.addEventListener("changed", (event) => {
      const data = parse<ChangedEvent>(event);
      for (const key of data?.keys ?? []) pending.add(key);
      for (const id of data?.workstreams ?? []) pendingWorkstreams.add(id);
      flushTimer ??= setTimeout(flush, CHANGE_BATCH_MS);
    });
    es.addEventListener("status", (event) => {
      const status = parse<StatusPayload>(event);
      if (status) store.dispatch(api.util.upsertQueryData("getStatus", undefined, status));
    });
    es.addEventListener("reset", () => {
      store.dispatch(api.util.invalidateTags(["Inbox", "Subject", "Workstream", "Status"]));
    });
  };

  connect();
  return () => {
    stopped = true;
    source?.close();
    if (flushTimer) clearTimeout(flushTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    store.dispatch(connectionChanged("closed"));
  };
}
