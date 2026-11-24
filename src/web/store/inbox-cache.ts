import type { InboxPayload, InboxRow, RepoCounts, Section, SectionCounts } from "../../core/index.ts";

const SECTION_ORDER: Record<Section, number> = { waiting: 0, updates: 1, snoozed: 2, hidden: 3 };

/** Same order as the server's inbox: section, newest activity first, then key. */
export function compareRows(a: InboxRow, b: InboxRow): number {
  return (
    SECTION_ORDER[a.section] - SECTION_ORDER[b.section] ||
    (a.sortAt < b.sortAt ? 1 : a.sortAt > b.sortAt ? -1 : 0) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

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

  const sections: SectionCounts = { waiting: 0, updates: 0, snoozed: 0, hidden: 0 };
  const repos = new Map<string, RepoCounts>();
  for (const row of rows) {
    sections[row.section] += 1;
    if (row.section === "waiting" || row.section === "updates") {
      const counts = repos.get(row.repo) ?? { repo: row.repo, waiting: 0, updates: 0 };
      counts[row.section] += 1;
      repos.set(row.repo, counts);
    }
  }
  if (!includeHidden) sections.hidden = Math.max(0, payload.sidebar.sections.hidden + hiddenDelta);
  return {
    ...payload,
    rows,
    sidebar: {
      sections,
      repos: [...repos.values()].sort(
        (a, b) => b.waiting + b.updates - (a.waiting + a.updates) || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0),
      ),
    },
  };
}
