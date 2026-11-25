import type { InboxRow, SubjectKey } from "../../core/index.ts";
import { type InboxEntry, type InboxGroup, isGroup } from "../../core/inbox.ts";
import type { WorkstreamPriority } from "../../core/workstream-placeholders.ts";
import { snoozeChoices } from "../ops.ts";
import { applyState, applyWorkstream } from "./state-api.ts";
import {
  moveSelection,
  snoozeMenuClosed,
  snoozeMenuOpened,
  type SnoozeMenuState,
  type ViewThunk,
} from "./view.ts";

export function isMuted(row: InboxRow): boolean {
  return row.reasons.includes("muted");
}

export function markDone(keys: SubjectKey[]): ViewThunk {
  return applyState(keys, { kind: "done" });
}

export function toggleMute(row: InboxRow): ViewThunk {
  return applyState([row.key], { kind: isMuted(row) ? "unmute" : "mute" });
}

export function muteAndUnsubscribe(row: InboxRow): ViewThunk {
  return applyState([row.key], { kind: "unsubscribe" });
}

export function toggleUnread(row: InboxRow): ViewThunk {
  return applyState([row.key], { kind: row.unread ? "read" : "unread" });
}

export function openSnoozeMenu(rows: InboxRow[], anchor: SnoozeMenuState["anchor"] = null): ViewThunk {
  return (dispatch) => {
    if (rows.length === 0) return;
    dispatch(
      snoozeMenuOpened({
        keys: rows.map((row) => row.key),
        draft: rows.every((row) => row.draft),
        snoozed: rows.every((row) => row.section === "snoozed"),
        anchor,
      }),
    );
  };
}

export function menuChoices(menu: SnoozeMenuState, now: Date) {
  return snoozeChoices(now, { draft: menu.draft, snoozed: menu.snoozed });
}

/** Applies the snooze menu choice at `index`, or the highlighted one when omitted. */
export function chooseSnooze(index?: number): ViewThunk {
  return (dispatch, getState) => {
    const menu = getState().view.snoozeMenu;
    if (!menu) return;
    const choice = menuChoices(menu, new Date())[index ?? menu.index];
    if (!choice) return;
    dispatch(snoozeMenuClosed());
    const { op } = choice;
    if (menu.workstream !== undefined && (op.kind === "snooze" || op.kind === "unsnooze")) {
      dispatch(applyWorkstream(menu.workstream, op));
    } else {
      dispatch(applyState(menu.keys, op));
    }
  };
}

/** "Done all" asks for confirmation above this many rows. */
export const CONFIRM_DONE_ALL = 20;

/** True when `count` items may be marked done: small batches go through, larger ones ask first. */
export function confirmDoneAll(count: number): boolean {
  return count <= CONFIRM_DONE_ALL || window.confirm(`Mark all ${count} items done?`);
}

/** Subject keys "Done all" acts on: loose rows plus the members each group shows. */
export function doneKeys(entries: readonly InboxEntry[]): SubjectKey[] {
  const keys = new Set<SubjectKey>();
  for (const entry of entries) {
    if (isGroup(entry)) for (const member of entry.members) keys.add(member.key);
    else keys.add(entry.key);
  }
  return [...keys];
}

/** Marks the group's shown members done, one per-subject done op for the batch. */
export function doneAllWorkstream(group: InboxGroup): ViewThunk {
  return (dispatch) => {
    const keys = doneKeys([group]);
    if (keys.length === 0 || !confirmDoneAll(keys.length)) return;
    dispatch(markDone(keys));
  };
}

export function setWorkstreamPriority(group: InboxGroup, priority: WorkstreamPriority): ViewThunk {
  return applyWorkstream(group.id, { kind: "setPriority", priority });
}

export function toggleWorkstreamMute(group: InboxGroup): ViewThunk {
  return setWorkstreamPriority(group, group.priority === "muted" ? "normal" : "muted");
}

/** Renames the group; an empty name goes back to the generated name. */
export function renameWorkstream(group: InboxGroup, name: string): ViewThunk {
  const trimmed = name.trim();
  return applyWorkstream(group.id, { kind: "rename", name: trimmed === "" ? null : trimmed });
}

/** Records that the group was opened, clearing "new workstream" and "summary changed". */
export function markWorkstreamSeen(group: InboxGroup): ViewThunk {
  return (dispatch) => {
    if (!group.isNew && !group.summary?.changed) return;
    dispatch(applyWorkstream(group.id, { kind: "seen", summaryHash: group.summary?.hash ?? null }));
  };
}

export function openWorkstreamSnooze(group: InboxGroup, anchor: SnoozeMenuState["anchor"] = null): ViewThunk {
  return (dispatch) => {
    dispatch(
      snoozeMenuOpened({
        keys: [],
        workstream: group.id,
        draft: group.members.length > 0 && group.members.every((row) => row.draft),
        snoozed: group.snoozed,
        anchor,
      }),
    );
  };
}

export function nextRow(): ViewThunk {
  return moveSelection(1);
}
