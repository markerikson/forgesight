import type { InboxRow, SubjectKey } from "../../core/index.ts";
import { snoozeChoices } from "../ops.ts";
import { applyState } from "./state-api.ts";
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
    dispatch(applyState(menu.keys, choice.op));
  };
}

export function nextRow(): ViewThunk {
  return moveSelection(1);
}
