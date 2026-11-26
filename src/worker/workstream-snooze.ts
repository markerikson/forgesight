import type { Database } from "bun:sqlite";
import type { Config } from "../core/config.ts";
import { subjectEvents } from "../core/pipeline/index.ts";
import type { ViewEvent } from "../core/pipeline/types.ts";
import type { SubjectKey } from "../core/types.ts";
import {
  applyWorkstreamOp,
  snoozeWakesOnActivity,
  type WorkstreamState,
  workstreamSnoozeActive,
} from "../core/workstream-state.ts";
import { getSubject } from "../store/subjects.ts";
import { stickiesFor, timelineFor } from "../store/timeline.ts";
import { getWorkstream, getWorkstreamStates, putWorkstreamState, workstreamIdsFor } from "../store/workstreams.ts";

/** Classified events of a stored subject; none for a listing-only member. */
function memberEvents(db: Database, config: Config, key: SubjectKey): ViewEvent[] {
  const subject = getSubject(db, key);
  if (!subject) return [];
  return subjectEvents({
    subject,
    items: timelineFor(db, key),
    stickies: stickiesFor(db, key),
    config,
    me: config.me,
    dismissedAt: null,
  });
}

/**
 * Whether a workstream snooze still holds. Member events are loaded only when the time
 * condition holds and the snooze also waits for a reply or for ready-for-review.
 */
export function groupSnoozed(
  db: Database,
  config: Config,
  state: WorkstreamState,
  members: readonly SubjectKey[],
  now: Date,
): boolean {
  const me = config.me ?? null;
  if (!workstreamSnoozeActive(state, [], me, now)) return false;
  if (!snoozeWakesOnActivity(state)) return true;
  return workstreamSnoozeActive(
    state,
    members.map((key) => memberEvents(db, config, key)),
    me,
    now,
  );
}

/**
 * Ends the snooze of each workstream of `keys` that member activity woke, and returns their
 * IDs. Storing the wake keeps the group awake when the member that woke it later leaves.
 */
export function endWokenSnoozes(db: Database, config: Config, keys: readonly SubjectKey[], now: Date): string[] {
  if (keys.length === 0) return [];
  const ids = [...new Set(workstreamIdsFor(db, [...keys]).values())];
  const states = getWorkstreamStates(db, ids);
  const me = config.me ?? null;
  const nowIso = now.toISOString();
  const woken: string[] = [];
  for (const id of ids) {
    const state = states.get(id);
    if (!state || !snoozeWakesOnActivity(state) || !workstreamSnoozeActive(state, [], me, now)) continue;
    const members = getWorkstream(db, id)?.members.map((m) => m.key) ?? [];
    if (groupSnoozed(db, config, state, members, now)) continue;
    putWorkstreamState(db, id, applyWorkstreamOp(state, { kind: "unsnooze" }, nowIso), nowIso);
    woken.push(id);
  }
  return woken;
}
