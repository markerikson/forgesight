import { type InboxEntry, type InboxGroup, isGroup, settleInbox } from "../../core/inbox.ts";
import type { InboxPayload, InboxRow } from "../../core/index.ts";

/**
 * Puts the server's rows and workstream groups from a state change into a cached inbox:
 * replaced in place, moved by section or into and out of their groups, or dropped when they
 * are hidden and this cache was fetched without hidden entries. A group mapped to null is
 * gone (merged away); its members become their own rows.
 */
export function replaceRows(
  payload: InboxPayload,
  changed: Readonly<Record<string, InboxRow>>,
  includeHidden: boolean,
  changedGroups: Readonly<Record<string, InboxGroup | null>> = {},
): InboxPayload {
  const pending = new Map(Object.entries(changed));
  const pendingGroups = new Map(Object.entries(changedGroups));
  if (pending.size === 0 && pendingGroups.size === 0) return payload;
  // A row can be cached twice (a rollback group lists it and its patched copy sits elsewhere),
  // so replace every copy; reflow keeps one.
  const replaced = new Set<string>();
  const replace = (row: InboxRow): InboxRow => {
    const next = pending.get(row.key);
    if (!next) return row;
    replaced.add(row.key);
    return next;
  };
  const entries: InboxEntry[] = [];
  for (const entry of payload.rows) {
    if (!isGroup(entry)) {
      entries.push(replace(entry));
      continue;
    }
    if (!pendingGroups.has(entry.id)) {
      entries.push({ ...entry, members: entry.members.map(replace) });
      continue;
    }
    const next = pendingGroups.get(entry.id) ?? null;
    pendingGroups.delete(entry.id);
    if (!next) {
      entries.push(...entry.members.map(replace));
      continue;
    }
    // Keep the cached copy of each member unless the server sent a new one, and keep cached
    // members the new group does not list as their own rows so reflow can place them.
    const current = new Map(entry.members.map((m) => [m.key, m]));
    entries.push({ ...next, members: next.members.map((m) => replace(current.get(m.key) ?? m)) });
    for (const member of entry.members) {
      if (!next.members.some((m) => m.key === member.key)) entries.push(replace(member));
    }
  }
  let returned = 0;
  for (const group of pendingGroups.values()) {
    if (!group || (!includeHidden && group.section === "hidden")) continue;
    entries.push({ ...group, members: group.members.map(replace) });
    // A group this cache did not list came back from Hidden.
    if (!includeHidden) returned += 1;
  }
  for (const next of pending.values()) {
    if (replaced.has(next.key)) continue;
    if (next.section === "hidden") {
      if (includeHidden) entries.push(next);
      continue;
    }
    entries.push(next);
    // A row this cache did not list came back from Hidden.
    if (!includeHidden) returned += 1;
  }
  return settleInbox(payload, entries, includeHidden, returned);
}
