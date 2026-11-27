import type { CollapsedGroup, Round, SubjectDetail, ViewEvent } from "../core/index.ts";
import { isMe } from "../core/pipeline/classify.ts";

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
 * Events that `base` did not have arrived while reading and count as new, unless the viewer
 * wrote them or GitHub gave them no timestamp. A round also stays new when its `base` round
 * was new, since that flag can come from hidden events this function cannot see.
 */
export function keepNewFlags(base: SubjectDetail, fresh: SubjectDetail, me: string | null): SubjectDetail {
  if (base.key !== fresh.key) return fresh;
  const known = eventFlags(base);
  const newRounds = new Set(base.rounds.filter((r) => r.isNew).map((r) => r.startedAt));
  const flag = (event: ViewEvent): ViewEvent => {
    const isNew = known.get(event.id) ?? (event.isNew || (!event.undated && !isMe(event.actor?.login, me)));
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
      r.isNew ||
      newRounds.has(r.startedAt) ||
      (startedBy?.isNew ?? false) ||
      commits.some((c) => c.isNew) ||
      entries.some((e) => (e.type === "event" ? e.event.isNew : e.group.isNew));
    return { ...r, startedBy, commits, entries, isNew };
  };
  return { ...fresh, rounds: fresh.rounds.map(round), lastVisitAt: base.lastVisitAt, ...keepNewFindings(base, fresh) };
}

/**
 * Findings keep their `base` "new" marker; ones `base` did not have arrived while reading.
 * Without a `base` list there is nothing to compare, so the server's markers stand.
 */
function keepNewFindings(base: SubjectDetail, fresh: SubjectDetail): Pick<SubjectDetail, "findings"> {
  if (!fresh.findings || !base.findings) return {};
  const known = new Map(base.findings.map((f) => [`${f.tool}:${f.id}`, f.isNew]));
  const findings = fresh.findings.map((f) => {
    const isNew = known.get(`${f.tool}:${f.id}`) ?? true;
    return isNew === f.isNew ? f : { ...f, isNew };
  });
  return { findings };
}
