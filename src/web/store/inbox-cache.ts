import { compareRows, repoCounts, sectionCounts } from "../../core/inbox.ts";
import type { InboxPayload, InboxRow } from "../../core/index.ts";

/**
 * Puts the server's rows from a state change into a cached inbox: replaced in place, moved by section,
 * or dropped when they are hidden and this cache was fetched without hidden rows.
 */
export function replaceRows(
  payload: InboxPayload,
  changed: Readonly<Record<string, InboxRow>>,
  includeHidden: boolean,
): InboxPayload {
  const pending = new Map(Object.entries(changed));
  if (pending.size === 0) return payload;
  let hiddenDelta = 0;
  const rows: InboxRow[] = [];
  for (const row of payload.rows) {
    const next = pending.get(row.key);
    if (!next) {
      rows.push(row);
      continue;
    }
    pending.delete(row.key);
    if (!includeHidden && next.section === "hidden") hiddenDelta += 1;
    if (includeHidden || next.section !== "hidden") rows.push(next);
  }
  for (const next of pending.values()) {
    if (next.section === "hidden") {
      if (includeHidden) rows.push(next);
      continue;
    }
    rows.push(next);
    // A row this cache did not list came back from Hidden.
    if (!includeHidden) hiddenDelta -= 1;
  }
  rows.sort(compareRows);

  const sections = sectionCounts(rows);
  if (!includeHidden) sections.hidden = Math.max(0, payload.sidebar.sections.hidden + hiddenDelta);
  return { ...payload, rows, sidebar: { sections, repos: repoCounts(rows) } };
}
