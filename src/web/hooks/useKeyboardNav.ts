import { useEffect } from "react";
import type { Section, SubjectView } from "../../core/index.ts";
import { api } from "../store/api.ts";
import { useAppStore } from "../store/hooks.ts";
import {
  groupId,
  groupsToggled,
  helpClosed,
  helpToggled,
  moveSelection,
  roundFocused,
  sectionSelected,
  selectSelectedRow,
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
  | { type: "prefix" }
  | { type: "section"; section: Section }
  | { type: "help" }
  | { type: "closeHelp" };

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

const SECTION_KEYS: Record<string, Section> = { w: "waiting", u: "updates", s: "snoozed", h: "hidden" };

/** Maps a keydown to an inbox action. `afterG` is true when the previous key was the `g` prefix. */
export function keyAction(e: KeyInput, afterG: boolean): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isEditable(e.target)) return null;
  if (e.key === "Enter" && activatesOnEnter(e.target)) return null;
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
    case "g":
      return { type: "prefix" };
    case "?":
      return { type: "help" };
    case "Escape":
      return { type: "closeHelp" };
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
      const action = keyAction(e, afterG);
      afterG = action?.type === "prefix";
      if (!action) return;

      const state = store.getState();
      if (state.view.helpOpen && action.type !== "help" && action.type !== "closeHelp") return;
      if (action.type === "closeHelp" && !state.view.helpOpen) return;
      e.preventDefault();

      const row = selectSelectedRow(state);
      const subject = row ? api.endpoints.getSubject.select(row.key)(state).data : undefined;

      switch (action.type) {
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
          store.dispatch(sectionSelected(action.section));
          break;
        case "help":
          store.dispatch(helpToggled());
          break;
        case "closeHelp":
          store.dispatch(helpClosed());
          break;
        case "prefix":
          break;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [store]);
}
