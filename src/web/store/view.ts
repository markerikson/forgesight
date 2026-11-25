import { createSelector, createSlice, type PayloadAction, type ThunkAction, type UnknownAction } from "@reduxjs/toolkit";
import type { InboxPayload, InboxRow, Section } from "../../core/index.ts";
import { api, POLL_MS } from "./api.ts";
import { compareRows, entryKey, groupKey, type InboxEntry, type InboxGroup, isGroup } from "../../core/inbox.ts";

export interface ViewState {
  section: Section;
  /** Repo filter within the section; null shows every repo. */
  repo: string | null;
  selectedKey: string | null;
  /** Index of the selected row in the visible list, kept so the selection can fall back to a neighbor. */
  selectedIndex: number;
  /** Ids of collapsed groups the user expanded (see `groupId`). */
  expandedGroups: string[];
  /** Ids of workstream groups expanded in the list. */
  expandedWorkstreams: string[];
  /** Expanded workstreams showing every listed member instead of the first `MEMBER_CAP`. */
  fullWorkstreams: string[];
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
  /** Set when the change was to a workstream rather than to subjects. */
  workstream?: string;
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
  /** Set when the menu snoozes a workstream; `keys` is then empty. */
  workstream?: string;
  /** Highlighted choice. */
  index: number;
  draft: boolean;
  snoozed: boolean;
  /** Viewport position of the button that opened it; null centers the menu. */
  anchor: { top: number; left: number } | null;
}

export type Connection = "open" | "connecting" | "closed";

export const UNDO_LIMIT = 20;
/** Members an expanded workstream lists before its "and N more" expander. */
export const MEMBER_CAP = 8;

export const initialViewState: ViewState = {
  section: "waiting",
  repo: null,
  selectedKey: null,
  selectedIndex: 0,
  expandedGroups: [],
  expandedWorkstreams: [],
  fullWorkstreams: [],
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
    /** Expands or collapses workstream `id`; `expand` omitted toggles. */
    workstreamToggled(state, action: PayloadAction<{ id: string; expand?: boolean }>) {
      const { id } = action.payload;
      const open = state.expandedWorkstreams.includes(id);
      const expand = action.payload.expand ?? !open;
      if (expand === open) return;
      if (expand) state.expandedWorkstreams.push(id);
      else {
        state.expandedWorkstreams = state.expandedWorkstreams.filter((w) => w !== id);
        state.fullWorkstreams = state.fullWorkstreams.filter((w) => w !== id);
      }
    },
    workstreamShowAll(state, action: PayloadAction<string>) {
      if (!state.fullWorkstreams.includes(action.payload)) state.fullWorkstreams.push(action.payload);
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
  workstreamToggled,
  workstreamShowAll,
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

export function filterRows<E extends InboxEntry>(rows: readonly E[], section: Section, repo: string | null): E[] {
  return rows.filter((row) => row.section === section && (repo === null || row.repo === repo));
}

/**
 * The selected entry, or its nearest neighbor when it left the list. Nothing is selected until
 * the user picks a row, so opening a section or repo does not mark its first row read.
 */
export function resolveSelection(
  visible: readonly InboxEntry[],
  key: string | null,
  index: number,
): InboxEntry | null {
  if (visible.length === 0 || key === null) return null;
  const found = visible.find((entry) => entryKey(entry) === key);
  if (found) return found;
  // A member of a collapsed workstream (say, restored from the URL) selects its group.
  const owner = visible.find((entry) => isGroup(entry) && entry.members.some((member) => member.key === key));
  if (owner) return owner;
  return visible[Math.min(Math.max(index, 0), visible.length - 1)] ?? null;
}

/** Keys of every subject the entries list, including workstream members. */
export function listedKeys(entries: readonly InboxEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (isGroup(entry)) for (const member of entry.members) keys.add(member.key);
    else keys.add(entry.key);
  }
  return keys;
}

/**
 * The navigable list: each entry, and after an expanded workstream its members, up to
 * `MEMBER_CAP` unless the workstream shows all of them.
 */
export function flattenEntries(
  entries: readonly InboxEntry[],
  expanded: readonly string[],
  full: readonly string[],
): InboxEntry[] {
  if (expanded.length === 0) return entries as InboxEntry[];
  const out: InboxEntry[] = [];
  for (const entry of entries) {
    out.push(entry);
    if (!isGroup(entry) || !expanded.includes(entry.id)) continue;
    out.push(...(full.includes(entry.id) ? entry.members : entry.members.slice(0, MEMBER_CAP)));
  }
  return out;
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

const emptyRows: InboxEntry[] = [];

/** The section's entries plus read rows the inbox no longer lists, each in its sort position. */
export function withLingering(
  live: readonly InboxEntry[],
  lingering: readonly InboxRow[],
  section: Section,
  repo: string | null,
): InboxEntry[] {
  const visible = filterRows(live, section, repo);
  if (lingering.length === 0) return visible;
  const liveKeys = listedKeys(live);
  const extra = lingering.filter((row) => !liveKeys.has(row.key) && (repo === null || row.repo === repo));
  if (extra.length === 0) return visible;

  // A read member stays inside its workstream, in stack order, rather than as a loose row. The
  // optimistic patch has already moved it to Hidden, so only loose rows are filtered by section.
  const joined = new Map<string, InboxRow[]>();
  const loose: InboxRow[] = [];
  for (const row of extra) {
    const owner = visible.find((entry) => isGroup(entry) && entry.memberKeys.includes(row.key));
    if (owner) joined.set(entryKey(owner), [...(joined.get(entryKey(owner)) ?? []), row]);
    else if (row.section === section) loose.push(row);
  }
  const entries: InboxEntry[] = [];
  for (const entry of visible) {
    const rows = isGroup(entry) ? joined.get(entryKey(entry)) : undefined;
    if (!isGroup(entry) || !rows) {
      entries.push(entry);
      continue;
    }
    const order = (row: InboxRow) => entry.memberKeys.indexOf(row.key);
    const members = [...entry.members, ...rows].sort((a, b) => order(a) - order(b));
    const keys = new Set(rows.map((row) => row.key));
    entries.push({
      ...entry,
      members,
      unlisted: entry.unlisted.filter((member) => !keys.has(member.key)),
      moreCount: Math.max(0, entry.moreCount - rows.length),
    });
  }
  return loose.length === 0 ? entries : [...entries, ...loose].sort(compareRows);
}

const selectLiveRows = (state: ViewRootState) => selectInbox(state)?.rows ?? emptyRows;
const selectLingering = (state: ViewRootState) => state.view.lingering;

/** Top-level entries: rows and workstream groups, without expanded members. */
export const selectTopEntries = createSelector(
  [selectLiveRows, selectLingering, selectSection, selectRepo],
  withLingering,
);

/** The navigable list, with the members of expanded workstreams after their group. */
export const selectVisibleRows = createSelector(
  [
    selectTopEntries,
    (state: ViewRootState) => state.view.expandedWorkstreams,
    (state: ViewRootState) => state.view.fullWorkstreams,
  ],
  flattenEntries,
);

/** Workstream group of each listed member row. */
export const selectGroupOf = createSelector([selectTopEntries], (entries) => {
  const groups = new Map<string, InboxGroup>();
  for (const entry of entries) {
    if (isGroup(entry)) for (const member of entry.members) groups.set(member.key, entry);
  }
  return groups;
});

/** Keys of listed rows the inbox itself no longer has; the list dims them. */
export const selectGoneKeys = createSelector([selectLiveRows, selectLingering], (live, lingering) => {
  const liveKeys = listedKeys(live);
  return new Set(lingering.filter((row) => !liveKeys.has(row.key)).map((row) => row.key));
});

export const selectSelectedEntry = createSelector(
  [selectVisibleRows, (state: ViewRootState) => state.view.selectedKey, (state: ViewRootState) => state.view.selectedIndex],
  resolveSelection,
);

/** The selected subject row; null when nothing or a workstream group is selected. */
export const selectSelectedRow = (state: ViewRootState): InboxRow | null => {
  const entry = selectSelectedEntry(state);
  return entry && !isGroup(entry) ? entry : null;
};

export const selectSelectedGroup = (state: ViewRootState): InboxGroup | null => {
  const entry = selectSelectedEntry(state);
  return entry && isGroup(entry) ? entry : null;
};

export const selectSelectedIndex = createSelector([selectVisibleRows, selectSelectedEntry], (rows, entry) =>
  entry ? rows.indexOf(entry) : -1,
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
    if (row) dispatch(rowSelected({ key: entryKey(row), index }));
  };
}

/**
 * Selects a subject by key, expanding its workstream (and lifting the member cap) when it sits
 * inside one. Returns false when the subject is not in the current list.
 */
export function selectSubject(key: string): ViewThunk<boolean> {
  return (dispatch, getState) => {
    const group = selectGroupOf(getState()).get(key);
    if (group) {
      dispatch(workstreamToggled({ id: group.id, expand: true }));
      dispatch(workstreamShowAll(group.id));
    }
    const index = selectVisibleRows(getState()).findIndex((entry) => entryKey(entry) === key);
    if (index === -1) return false;
    dispatch(rowSelected({ key, index }));
    return true;
  };
}

/**
 * Expands or collapses a workstream (toggles when `expand` is omitted). Collapsing while one of
 * its members is selected moves the selection to the group row.
 */
export function toggleWorkstream(id: string, expand?: boolean): ViewThunk {
  return (dispatch, getState) => {
    const member = selectSelectedRow(getState());
    const memberOfThis = member !== null && selectGroupOf(getState()).get(member.key)?.id === id;
    dispatch(workstreamToggled(expand === undefined ? { id } : { id, expand }));
    if (!memberOfThis || getState().view.expandedWorkstreams.includes(id)) return;
    const key = groupKey(id);
    const index = selectVisibleRows(getState()).findIndex((entry) => entryKey(entry) === key);
    if (index !== -1) dispatch(rowSelected({ key, index }));
  };
}
