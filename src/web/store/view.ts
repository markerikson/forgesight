import { createSelector, createSlice, type PayloadAction, type ThunkAction, type UnknownAction } from "@reduxjs/toolkit";
import type { InboxPayload, InboxRow, Section } from "../../core/index.ts";
import { api, POLL_MS } from "./api.ts";
import { compareRows } from "../../core/inbox.ts";

export interface ViewState {
  section: Section;
  /** Repo filter within the section; null shows every repo. */
  repo: string | null;
  selectedKey: string | null;
  /** Index of the selected row in the visible list, kept so the selection can fall back to a neighbor. */
  selectedIndex: number;
  /** Ids of collapsed groups the user expanded (see `groupId`). */
  expandedGroups: string[];
  helpOpen: boolean;
  /** Focused round in the preview, 0 = newest. */
  roundIndex: number;
  /**
   * Rows read in this list, as they looked when read. They stay listed (dimmed) after a refetch drops
   * them, until the section or repo filter changes.
   */
  lingering: InboxRow[];
  /** Undoable changes, newest first. */
  undo: UndoEntry[];
  toast: Toast | null;
  /** Increments on every toast so a timer only dismisses the toast it was started for. */
  toastSeq: number;
  snoozeMenu: SnoozeMenuState | null;
  /** Live-update stream state; queries poll while it is not open. */
  connection: Connection;
}

export interface UndoEntry {
  opId: number;
  label: string;
  keys: string[];
  at: string;
  /** Read rows the change took out of the list; undo puts them back. */
  lingering?: InboxRow[];
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
  /** Set when the toast offers Undo. */
  opId?: number;
}

export interface SnoozeMenuState {
  keys: string[];
  /** Highlighted choice. */
  index: number;
  draft: boolean;
  snoozed: boolean;
  /** Viewport position of the button that opened it; null centers the menu. */
  anchor: { top: number; left: number } | null;
}

export type Connection = "open" | "connecting" | "closed";

export const UNDO_LIMIT = 20;

export const initialViewState: ViewState = {
  section: "waiting",
  repo: null,
  selectedKey: null,
  selectedIndex: 0,
  expandedGroups: [],
  helpOpen: false,
  roundIndex: 0,
  lingering: [],
  undo: [],
  toast: null,
  toastSeq: 0,
  snoozeMenu: null,
  connection: "closed",
};

export interface UrlState {
  section?: Section;
  repo?: string | null;
  selectedKey?: string | null;
}

export const viewSlice = createSlice({
  name: "view",
  initialState: initialViewState,
  reducers: {
    /** Switching sections (or reselecting the current one) also clears the repo filter. */
    sectionSelected(state, action: PayloadAction<Section>) {
      if (state.section === action.payload && state.repo === null) return;
      state.section = action.payload;
      state.repo = null;
      state.selectedKey = null;
      state.selectedIndex = 0;
      state.roundIndex = 0;
      state.lingering = [];
      state.snoozeMenu = null;
    },
    repoSelected(state, action: PayloadAction<string | null>) {
      state.repo = action.payload;
      state.selectedKey = null;
      state.selectedIndex = 0;
      state.roundIndex = 0;
      state.lingering = [];
      state.snoozeMenu = null;
    },
    /** `row` is the row as it looks once read. */
    rowRead(state, action: PayloadAction<InboxRow>) {
      state.lingering = [...state.lingering.filter((r) => r.key !== action.payload.key), action.payload];
    },
    lingeringDropped(state, action: PayloadAction<string[]>) {
      const keys = new Set(action.payload);
      if (state.lingering.some((r) => keys.has(r.key))) state.lingering = state.lingering.filter((r) => !keys.has(r.key));
    },
    undoPushed(state, action: PayloadAction<UndoEntry>) {
      state.undo = [action.payload, ...state.undo].slice(0, UNDO_LIMIT);
    },
    undoRemoved(state, action: PayloadAction<number>) {
      state.undo = state.undo.filter((entry) => entry.opId !== action.payload);
      if (state.toast?.opId === action.payload) state.toast = null;
    },
    toastShown: {
      reducer(state, action: PayloadAction<Omit<Toast, "id">>) {
        state.toastSeq += 1;
        state.toast = { ...action.payload, id: state.toastSeq };
      },
      prepare(message: string, opts: { kind?: Toast["kind"]; opId?: number } = {}) {
        const toast: Omit<Toast, "id"> = { message, kind: opts.kind ?? "info" };
        if (opts.opId !== undefined) toast.opId = opts.opId;
        return { payload: toast };
      },
    },
    /** Dismisses toast `id`, or whatever toast is showing when omitted. */
    toastDismissed(state, action: PayloadAction<number | undefined>) {
      if (action.payload === undefined || state.toast?.id === action.payload) state.toast = null;
    },
    snoozeMenuOpened(state, action: PayloadAction<Omit<SnoozeMenuState, "index">>) {
      state.snoozeMenu = { ...action.payload, index: 0 };
      state.helpOpen = false;
    },
    /** Moves the highlight, wrapping within `count` choices. */
    snoozeMenuMoved(state, action: PayloadAction<{ delta: number; count: number }>) {
      const menu = state.snoozeMenu;
      if (!menu || action.payload.count <= 0) return;
      const { delta, count } = action.payload;
      menu.index = (((menu.index + delta) % count) + count) % count;
    },
    snoozeMenuClosed(state) {
      state.snoozeMenu = null;
    },
    connectionChanged(state, action: PayloadAction<Connection>) {
      state.connection = action.payload;
    },
    rowSelected(state, action: PayloadAction<{ key: string; index: number }>) {
      if (state.selectedKey !== action.payload.key) state.roundIndex = 0;
      state.selectedKey = action.payload.key;
      state.selectedIndex = action.payload.index;
    },
    roundFocused(state, action: PayloadAction<number>) {
      state.roundIndex = Math.max(0, action.payload);
    },
    groupsToggled(state, action: PayloadAction<string[]>) {
      const ids = action.payload;
      const expanded = new Set(state.expandedGroups);
      const expand = ids.some((id) => !expanded.has(id));
      for (const id of ids) {
        if (expand) expanded.add(id);
        else expanded.delete(id);
      }
      state.expandedGroups = [...expanded];
    },
    helpToggled(state) {
      state.helpOpen = !state.helpOpen;
    },
    helpClosed(state) {
      state.helpOpen = false;
    },
    urlStateRestored(state, action: PayloadAction<UrlState>) {
      const { section, repo, selectedKey } = action.payload;
      if (section !== undefined) state.section = section;
      if (repo !== undefined) state.repo = repo;
      if (selectedKey !== undefined) state.selectedKey = selectedKey;
    },
  },
});

export const {
  sectionSelected,
  repoSelected,
  rowSelected,
  roundFocused,
  groupsToggled,
  helpToggled,
  helpClosed,
  urlStateRestored,
  rowRead,
  lingeringDropped,
  undoPushed,
  undoRemoved,
  toastShown,
  toastDismissed,
  snoozeMenuOpened,
  snoozeMenuMoved,
  snoozeMenuClosed,
  connectionChanged,
} = viewSlice.actions;

/** Collapsed groups have no id of their own; the first item's timeline id is stable across refetches. */
export function groupId(subjectKey: string, firstItemId: string): string {
  return `${subjectKey}:${firstItemId}`;
}

export function inboxArgFor(section: Section) {
  return { includeHidden: section === "hidden" };
}

export function filterRows(rows: readonly InboxRow[], section: Section, repo: string | null): InboxRow[] {
  return rows.filter((row) => row.section === section && (repo === null || row.repo === repo));
}

/** The selected row, or its nearest neighbor when it left the list, or the first row. */
export function resolveSelection(visible: readonly InboxRow[], key: string | null, index: number): InboxRow | null {
  if (visible.length === 0) return null;
  if (key !== null) {
    const found = visible.find((row) => row.key === key);
    if (found) return found;
  }
  return visible[Math.min(Math.max(index, 0), visible.length - 1)] ?? null;
}

export interface RepoCount {
  repo: string;
  count: number;
}

export function repoCounts(payload: InboxPayload | undefined, section: Section): RepoCount[] {
  if (!payload) return [];
  if (section === "waiting" || section === "updates") {
    return payload.sidebar.repos.map((r) => ({ repo: r.repo, count: r[section] })).filter((r) => r.count > 0);
  }
  const counts = new Map<string, number>();
  for (const row of payload.rows) {
    if (row.section === section) counts.set(row.repo, (counts.get(row.repo) ?? 0) + 1);
  }
  return [...counts].map(([repo, count]) => ({ repo, count }));
}

const selectWithHidden = api.endpoints.getInbox.select({ includeHidden: true });
const selectWithoutHidden = api.endpoints.getInbox.select({ includeHidden: false });

export type ViewRootState = Parameters<typeof selectWithHidden>[0] & { view: ViewState };

export const selectView = (state: ViewRootState) => state.view;
export const selectSection = (state: ViewRootState) => state.view.section;
export const selectRepo = (state: ViewRootState) => state.view.repo;

export const selectInbox = (state: ViewRootState): InboxPayload | undefined =>
  (state.view.section === "hidden" ? selectWithHidden(state) : selectWithoutHidden(state)).data;

const emptyRows: InboxRow[] = [];

/** The section's rows plus read rows the inbox no longer lists, each in its sort position. */
export function withLingering(
  live: readonly InboxRow[],
  lingering: readonly InboxRow[],
  section: Section,
  repo: string | null,
): InboxRow[] {
  const visible = filterRows(live, section, repo);
  if (lingering.length === 0) return visible;
  const liveKeys = new Set(live.map((row) => row.key));
  const extra = filterRows(lingering, section, repo).filter((row) => !liveKeys.has(row.key));
  return extra.length === 0 ? visible : [...visible, ...extra].sort(compareRows);
}

const selectLiveRows = (state: ViewRootState) => selectInbox(state)?.rows ?? emptyRows;
const selectLingering = (state: ViewRootState) => state.view.lingering;

export const selectVisibleRows = createSelector(
  [selectLiveRows, selectLingering, selectSection, selectRepo],
  withLingering,
);

/** Keys of listed rows the inbox itself no longer has; the list dims them. */
export const selectGoneKeys = createSelector([selectLiveRows, selectLingering], (live, lingering) => {
  const liveKeys = new Set(live.map((row) => row.key));
  return new Set(lingering.filter((row) => !liveKeys.has(row.key)).map((row) => row.key));
});

export const selectSelectedRow = createSelector(
  [selectVisibleRows, (state: ViewRootState) => state.view.selectedKey, (state: ViewRootState) => state.view.selectedIndex],
  resolveSelection,
);

export const selectSelectedIndex = createSelector([selectVisibleRows, selectSelectedRow], (rows, row) =>
  row ? rows.indexOf(row) : -1,
);

export const selectRepoCounts = createSelector([selectInbox, selectSection], repoCounts);

/** Polling stops while the event stream is open; the stream pushes changes instead. */
export const selectPollInterval = (state: ViewRootState) => (state.view.connection === "open" ? 0 : POLL_MS);

export type ViewThunk<R = void> = ThunkAction<R, ViewRootState, unknown, UnknownAction>;

export function moveSelection(delta: number): ViewThunk {
  return (dispatch, getState) => {
    const state = getState();
    const rows = selectVisibleRows(state);
    if (rows.length === 0) return;
    const current = selectSelectedIndex(state);
    const index = Math.min(Math.max(current + delta, 0), rows.length - 1);
    const row = rows[index];
    if (row) dispatch(rowSelected({ key: row.key, index }));
  };
}
