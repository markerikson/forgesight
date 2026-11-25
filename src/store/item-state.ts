import type { Database } from "bun:sqlite";
import type { ItemState } from "../core/types.ts";
import { bool, type ItemStateRow, itemStateFromRow, jsonList } from "./rows.ts";
import { appendChange } from "./views.ts";

export const DEFAULT_ITEM_STATE: Readonly<ItemState> = {
  dismissedAt: null,
  doneAt: null,
  readAt: null,
  keepUnread: false,
  snoozeUntil: null,
  snoozeUntilHumanEvent: false,
  snoozeUntilReady: false,
  snoozedAt: null,
  muted: false,
};

export function getItemState(db: Database, key: string): ItemState {
  const row = db
    .query<ItemStateRow, [string]>("SELECT * FROM item_state WHERE subject_key = ?")
    .get(key);
  return row ? itemStateFromRow(row) : { ...DEFAULT_ITEM_STATE };
}

/** States for the given subjects. Subjects without a stored row are absent from the map. */
export function getItemStates(db: Database, keys: string[]): Map<string, ItemState> {
  const rows = db
    .query<ItemStateRow, [string]>(
      "SELECT * FROM item_state WHERE subject_key IN (SELECT value FROM json_each(?))",
    )
    .all(jsonList(keys));
  return new Map(rows.map((r) => [r.subject_key, itemStateFromRow(r)]));
}

/** Subjects whose snooze ended in `(after, until]`; `after` null means any time up to `until`. */
export function snoozesEndedBetween(db: Database, after: string | null, until: string): string[] {
  return db
    .query<{ subject_key: string }, [string, string]>(
      `SELECT subject_key FROM item_state
       WHERE snooze_until IS NOT NULL AND snooze_until > ? AND snooze_until <= ?
       ORDER BY subject_key`,
    )
    .all(after ?? "", until)
    .map((r) => r.subject_key);
}

/** Replaces a subject's state and appends a `state` change in the same transaction. */
export function putItemState(db: Database, key: string, state: ItemState, now: string): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO item_state (subject_key, dismissed_at, done_at, read_at, keep_unread,
         snooze_until, snooze_until_human_event, snooze_until_ready, snoozed_at, muted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (subject_key) DO UPDATE SET
         dismissed_at = excluded.dismissed_at, done_at = excluded.done_at,
         read_at = excluded.read_at,
         keep_unread = excluded.keep_unread, snooze_until = excluded.snooze_until,
         snooze_until_human_event = excluded.snooze_until_human_event,
         snooze_until_ready = excluded.snooze_until_ready, snoozed_at = excluded.snoozed_at,
         muted = excluded.muted, updated_at = excluded.updated_at`,
    ).run(
      key,
      state.dismissedAt,
      state.doneAt,
      state.readAt,
      bool(state.keepUnread),
      state.snoozeUntil,
      bool(state.snoozeUntilHumanEvent),
      bool(state.snoozeUntilReady),
      state.snoozedAt,
      bool(state.muted),
      now,
    );
    appendChange(db, "state", key, now);
  })();
}

/**
 * Seeds `dismissed_at` for subjects with no stored state (backfill). Existing rows are
 * never overwritten, so a user's choice always wins.
 */
export function initDismissedAt(
  db: Database,
  rows: { key: string; dismissedAt: string }[],
  now: string,
): void {
  const insert = db.query(
    `INSERT INTO item_state (subject_key, dismissed_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (subject_key) DO NOTHING`,
  );
  db.transaction(() => {
    for (const r of rows) insert.run(r.key, r.dismissedAt, now);
  })();
}
