import { createSelector, createSlice, type PayloadAction, type ThunkAction, type UnknownAction } from "@reduxjs/toolkit";
import type { InboxRow, Section } from "../../core/index.ts";
import { api } from "./api.ts";
import type { InboxPayload } from "./types.ts";

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
}

export const initialViewState: ViewState = {
  section: "waiting",
  repo: null,
  selectedKey: null,
  selectedIndex: 0,
  expandedGroups: [],
  helpOpen: false,
  roundIndex: 0,
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
    sectionSelected(state, action: PayloadAction<Section>) {
      if (state.section === action.payload) return;
      state.section = action.payload;
      state.selectedKey = null;
      state.selectedIndex = 0;
      state.roundIndex = 0;
    },
    repoSelected(state, action: PayloadAction<string | null>) {
      state.repo = action.payload;
      state.selectedKey = null;
      state.selectedIndex = 0;
      state.roundIndex = 0;
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

export const selectVisibleRows = createSelector(
  [(state: ViewRootState) => selectInbox(state)?.rows ?? emptyRows, selectSection, selectRepo],
  filterRows,
);

export const selectSelectedRow = createSelector(
  [selectVisibleRows, (state: ViewRootState) => state.view.selectedKey, (state: ViewRootState) => state.view.selectedIndex],
  resolveSelection,
);

export const selectSelectedIndex = createSelector([selectVisibleRows, selectSelectedRow], (rows, row) =>
  row ? rows.indexOf(row) : -1,
);

export const selectRepoCounts = createSelector([selectInbox, selectSection], repoCounts);

type ViewThunk = ThunkAction<void, ViewRootState, unknown, UnknownAction>;

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
