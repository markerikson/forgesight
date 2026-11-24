import type { Cursor, Notification, Page } from "forges";
import { toNotificationThread } from "./schemas.ts";
import type { NotificationThread, PollResult } from "./types.ts";

export const NOTIFICATIONS_PER_PAGE = 50;
/** GitHub's usual `X-Poll-Interval`, used when a page carries no `nextPollAt`. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Reads one notifications page, from the start when `cursor` is undefined. */
export type FetchNotificationPage = (cursor: Cursor | undefined) => Promise<Page<Notification>>;

function threadsOf(page: Page<Notification>): NotificationThread[] {
  return page.items.map((n) => toNotificationThread(n.raw));
}

/** Turns the first page of a conditional read into a poll result. A throttled page counts as unchanged. */
export function toPollResult(page: Page<Notification>, now: Date): PollResult {
  const nextPollAt = page.nextPollAt ?? new Date(now.getTime() + DEFAULT_POLL_INTERVAL_MS);
  if (page.notModified || page.throttled) return { kind: "notModified", nextPollAt };
  return { kind: "changed", etag: page.etag ?? "", nextPollAt, threads: threadsOf(page) };
}

/** Every page, newest first, until the listing runs out. */
export async function* allPages(fetchPage: FetchNotificationPage): AsyncGenerator<NotificationThread[]> {
  let cursor: Cursor | undefined;
  do {
    const page = await fetchPage(cursor);
    const threads = threadsOf(page);
    if (threads.length > 0) yield threads;
    cursor = page.cursor;
  } while (cursor);
}

/** Pages newest first, stopping at the first thread updated before `cutoff`. */
export async function* pagesUntil(
  fetchPage: FetchNotificationPage,
  cutoff: Date,
): AsyncGenerator<NotificationThread[]> {
  const cutoffMs = cutoff.getTime();
  for await (const threads of allPages(fetchPage)) {
    const kept = threads.filter((t) => Date.parse(t.updatedAt) >= cutoffMs);
    if (kept.length > 0) yield kept;
    if (kept.length < threads.length) return;
  }
}
