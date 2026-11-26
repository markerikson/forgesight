import { useEffect } from "react";
import type { Section, SubjectView } from "../../core/index.ts";
import { api } from "../store/api.ts";
import {
  chooseSnooze,
  doneAllWorkstream,
  markDone,
  menuChoices,
  muteAndUnsubscribe,
  nextRow,
  openSnoozeMenu,
  openWorkstreamSnooze,
  toggleMute,
  toggleUnread,
  toggleWorkstreamMute,
} from "../store/actions.ts";
import { useAppStore } from "../store/hooks.ts";
import { refreshNow, undoLatest } from "../store/state-api.ts";
import {
  groupId,
  groupsToggled,
  helpClosed,
  helpToggled,
  moveSelection,
  roundFocused,
  selectGroupOf,
  selectSelectedGroup,
  selectSelectedRow,
  showSection,
  snoozeMenuClosed,
  snoozeMenuMoved,
  toggleWorkstream,
} from "../store/view.ts";

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

export type KeyAction =
  | { type: "move"; delta: number }
  | { type: "round"; delta: number }
  | { type: "open" }
  | { type: "toggleGroups" }
  | { type: "expand" }
  | { type: "collapse" }
  | { type: "prefix" }
  | { type: "section"; section: Section }
  | { type: "help" }
  | { type: "closeHelp" }
  | { type: "done" }
  | { type: "mute" }
  | { type: "unsubscribe" }
  | { type: "snooze" }
  | { type: "toggleUnread" }
  | { type: "undo" }
  | { type: "next" }
  | { type: "refresh" }
  | { type: "menuMove"; delta: number }
  | { type: "menuPick"; index: number }
  | { type: "menuChoose" }
  | { type: "menuClose" };

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]);

export function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return !NON_TEXT_INPUTS.has(el.type ?? "text");
  return false;
}

function activatesOnEnter(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const tag = (target as { tagName?: string }).tagName;
  return tag === "BUTTON" || tag === "A" || tag === "SUMMARY";
}

/**
 * Keys the browser turns into a click on the focused button or link. Space counts only inside the
 * snooze menu: elsewhere it means Next, because a clicked Done button keeps focus and Space would
 * press it again on the next row.
 */
function activatesNatively(e: KeyInput, menuOpen: boolean): boolean {
  return (e.key === "Enter" || (menuOpen && e.key === " ")) && activatesOnEnter(e.target);
}

const SECTION_KEYS: Record<string, Section> = { w: "waiting", u: "updates", s: "snoozed", h: "hidden" };

function menuKeyAction(key: string): KeyAction | null {
  if (/^[1-9]$/.test(key)) return { type: "menuPick", index: Number(key) - 1 };
  switch (key) {
    case "j":
    case "ArrowDown":
      return { type: "menuMove", delta: 1 };
    case "k":
    case "ArrowUp":
      return { type: "menuMove", delta: -1 };
    case "Enter":
      return { type: "menuChoose" };
    case "Escape":
      return { type: "menuClose" };
    default:
      return null;
  }
}

/**
 * Maps a keydown to an inbox action. `afterG` is true when the previous key was the `g` prefix.
 * While the snooze menu is open, keys only drive the menu.
 */
export function keyAction(e: KeyInput, afterG: boolean, menuOpen = false): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isEditable(e.target)) return null;
  if (activatesNatively(e, menuOpen)) return null;
  if (menuOpen) return menuKeyAction(e.key);
  if (afterG) {
    const section = SECTION_KEYS[e.key];
    return section ? { type: "section", section } : null;
  }
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return { type: "move", delta: 1 };
    case "k":
    case "ArrowUp":
      return { type: "move", delta: -1 };
    case "n":
      return { type: "round", delta: 1 };
    case "p":
      return { type: "round", delta: -1 };
    case "o":
    case "Enter":
      return { type: "open" };
    case "x":
      return { type: "toggleGroups" };
    case "l":
    case "ArrowRight":
      return { type: "expand" };
    case "h":
    case "ArrowLeft":
      return { type: "collapse" };
    case "g":
      return { type: "prefix" };
    case "?":
      return { type: "help" };
    case "Escape":
      return { type: "closeHelp" };
    case "e":
      return { type: "done" };
    case "m":
      return { type: "mute" };
    case "M":
      return { type: "unsubscribe" };
    case "s":
    case "z":
      return { type: "snooze" };
    case "u":
      return { type: "toggleUnread" };
    case "Z":
      return { type: "undo" };
    case " ":
      return { type: "next" };
    case "R":
      return { type: "refresh" };
    default:
      return null;
  }
}

/** Ids of the collapsed groups in one round, the unit `x` toggles. */
export function roundGroupIds(subject: SubjectView, roundIndex: number): string[] {
  const round = subject.rounds[roundIndex];
  if (!round) return [];
  const ids: string[] = [];
  for (const entry of round.entries) {
    const first = entry.type === "group" ? entry.group.items[0] : undefined;
    if (first) ids.push(groupId(subject.key, first.id));
  }
  return ids;
}

export function useKeyboardNav(): void {
  const store = useAppStore();

  useEffect(() => {
    let afterG = false;

    const onKeyDown = (e: KeyboardEvent) => {
      const menu = store.getState().view.snoozeMenu;
      const action = keyAction(e, afterG, menu !== null);
      afterG = action?.type === "prefix";
      if (menu) {
        // Swallow every key while the menu is open so nothing else reacts behind it.
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key !== "Tab" && !activatesNatively(e, true)) e.preventDefault();
        if (!action) return;
        switch (action.type) {
          case "menuMove":
            store.dispatch(snoozeMenuMoved({ delta: action.delta, count: menuChoices(menu, new Date()).length }));
            break;
          case "menuPick":
            store.dispatch(chooseSnooze(action.index));
            break;
          case "menuChoose":
            store.dispatch(chooseSnooze());
            break;
          case "menuClose":
            store.dispatch(snoozeMenuClosed());
            break;
        }
        return;
      }
      if (!action) return;

      const state = store.getState();
      if (state.view.helpOpen && action.type !== "help" && action.type !== "closeHelp") return;
      if (action.type === "closeHelp" && !state.view.helpOpen) return;
      e.preventDefault();

      const row = selectSelectedRow(state);
      const subject = row ? api.endpoints.getSubject.select(row.key)(state).data : undefined;
      const group = selectSelectedGroup(state);
      // The workstream a selected member row is listed under.
      const parentGroup = row ? selectGroupOf(state).get(row.key) : undefined;

      if (group) {
        switch (action.type) {
          case "open":
          case "toggleGroups":
            store.dispatch(toggleWorkstream(group.id));
            return;
          case "expand":
          case "collapse":
            store.dispatch(toggleWorkstream(group.id, action.type === "expand"));
            return;
          case "done":
            store.dispatch(doneAllWorkstream(group));
            return;
          case "mute":
            store.dispatch(toggleWorkstreamMute(group));
            return;
          case "snooze":
            store.dispatch(openWorkstreamSnooze(group, null));
            return;
          case "unsubscribe":
          case "toggleUnread":
          case "round":
            return;
          default:
            break;
        }
      }

      switch (action.type) {
        case "expand":
          break;
        case "collapse":
          if (parentGroup) store.dispatch(toggleWorkstream(parentGroup.id, false));
          break;
        case "move":
          store.dispatch(moveSelection(action.delta));
          break;
        case "round": {
          if (!subject || subject.rounds.length === 0) break;
          const next = Math.min(Math.max(state.view.roundIndex + action.delta, 0), subject.rounds.length - 1);
          store.dispatch(roundFocused(next));
          break;
        }
        case "open": {
          const url = subject?.githubUrl ?? row?.url;
          if (url) window.open(url, "_blank", "noopener,noreferrer");
          break;
        }
        case "toggleGroups":
          if (subject) store.dispatch(groupsToggled(roundGroupIds(subject, state.view.roundIndex)));
          break;
        case "section":
          store.dispatch(showSection(action.section));
          break;
        case "help":
          store.dispatch(helpToggled());
          break;
        case "closeHelp":
          store.dispatch(helpClosed());
          break;
        case "done":
          if (row) store.dispatch(markDone([row.key]));
          break;
        case "mute":
          if (row) store.dispatch(toggleMute(row));
          break;
        case "unsubscribe":
          if (row) store.dispatch(muteAndUnsubscribe(row));
          break;
        case "snooze":
          if (row) store.dispatch(openSnoozeMenu([row]));
          break;
        case "toggleUnread":
          if (row) store.dispatch(toggleUnread(row));
          break;
        case "undo":
          store.dispatch(undoLatest());
          break;
        case "next":
          store.dispatch(nextRow());
          break;
        case "refresh":
          store.dispatch(refreshNow());
          break;
        case "prefix":
        case "menuMove":
        case "menuPick":
        case "menuChoose":
        case "menuClose":
          break;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [store]);
}
