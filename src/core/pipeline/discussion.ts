import type { ViewEvent } from "./types.ts";

/**
 * Orders discussion events as a thread: each top-level event in time order,
 * with its replies right after it. Replies whose parent is missing stay in
 * time order at the top level.
 */
export function threadOrder(events: ViewEvent[]): ViewEvent[] {
  const ids = new Set(events.map((e) => e.id));
  const replies = new Map<string, ViewEvent[]>();
  const top: ViewEvent[] = [];
  for (const e of events) {
    const parent = e.data.replyTo;
    if (parent !== undefined && ids.has(parent)) {
      const list = replies.get(parent) ?? [];
      list.push(e);
      replies.set(parent, list);
    } else {
      top.push(e);
    }
  }
  const ordered: ViewEvent[] = [];
  for (const e of top) ordered.push(e, ...(replies.get(e.id) ?? []));
  return ordered;
}
