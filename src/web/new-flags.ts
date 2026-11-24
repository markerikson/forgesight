import type { CollapsedGroup, Round, SubjectDetail, ViewEvent } from "../core/index.ts";

function eventFlags(detail: SubjectDetail): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  const add = (event: ViewEvent) => flags.set(event.id, event.isNew);
  for (const round of detail.rounds) {
    if (round.startedBy) add(round.startedBy);
    round.commits.forEach(add);
    for (const entry of round.entries) {
      if (entry.type === "event") add(entry.event);
      else entry.group.items.forEach(add);
    }
  }
  return flags;
}

/**
 * Re-applies the "new" markers from `base`, the detail as it looked when the user started
 * reading it, to a `fresh` copy of the same subject. Reading clears the markers on the server,
 * so without this the last-visit line would vanish while the thread is still on screen.
 * Events that `base` did not have arrived while reading and count as new.
 */
export function keepNewFlags(base: SubjectDetail, fresh: SubjectDetail): SubjectDetail {
  if (base.key !== fresh.key) return fresh;
  const known = eventFlags(base);
  const flag = (event: ViewEvent): ViewEvent => {
    const isNew = known.get(event.id) ?? true;
    return isNew === event.isNew ? event : { ...event, isNew };
  };
  const group = (g: CollapsedGroup): CollapsedGroup => {
    const items = g.items.map(flag);
    return { ...g, items, isNew: items.some((item) => item.isNew) };
  };
  const round = (r: Round): Round => {
    const startedBy = r.startedBy && flag(r.startedBy);
    const commits = r.commits.map(flag);
    const entries = r.entries.map((entry) =>
      entry.type === "event" ? { type: "event" as const, event: flag(entry.event) } : { type: "group" as const, group: group(entry.group) },
    );
    const isNew =
      (startedBy?.isNew ?? false) ||
      commits.some((c) => c.isNew) ||
      entries.some((e) => (e.type === "event" ? e.event.isNew : e.group.isNew));
    return { ...r, startedBy, commits, entries, isNew };
  };
  return { ...fresh, rounds: fresh.rounds.map(round), lastVisitAt: base.lastVisitAt };
}
