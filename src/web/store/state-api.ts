import { current, type Draft, type ThunkDispatch, type UnknownAction } from "@reduxjs/toolkit";
import type { InboxPayload, InboxRow, SubjectKey } from "../../core/index.ts";
import { entryKey, type InboxEntry, type InboxGroup, isGroup } from "../../core/inbox.ts";
import { MAX_STATE_KEYS, patchInbox, patchWorkstream, type StateOp } from "../../core/state.ts";
import type {
  WorkstreamOp,
  WorkstreamStateRequest,
  WorkstreamStateResponse,
} from "../../core/workstream-placeholders.ts";
import type { StateRequest, StateResponse, UndoResponse } from "../../server/handlers/state.ts";
import { opLabel, workstreamOpLabel } from "../ops.ts";
import { api, type InboxArg } from "./api.ts";
import { replaceRows } from "./inbox-cache.ts";
import {
  lingeringDropped,
  resolveSelection,
  rowRead,
  rowSelected,
  selectSelectedEntry,
  selectVisibleRows,
  toastShown,
  undoPushed,
  undoRemoved,
  type ViewRootState,
  type ViewThunk,
} from "./view.ts";

// PLACEHOLDER: replaced by m4-store branch at merge. Undoing a workstream change also returns
// the groups it touched.
type UndoStateResponse = Extract<UndoResponse, { result: "undone" }> & {
  groups?: Record<string, InboxGroup | null>;
};
type UndoRefusal = Exclude<UndoResponse["result"], "undone">;

function refusalOf(error: unknown): UndoRefusal | null {
  if (typeof error !== "object" || error === null || !("error" in error)) return null;
  const inner = (error as { error: unknown }).error;
  if (typeof inner !== "object" || inner === null || !("data" in inner)) return null;
  const data = (inner as { data: unknown }).data;
  if (typeof data !== "object" || data === null || !("result" in data)) return null;
  const result = (data as { result: unknown }).result;
  return result === "superseded" || result === "alreadyUndone" || result === "notFound" ? result : null;
}

const asPayload = (draft: Draft<InboxPayload>) => current(draft) as InboxPayload;

function cachedInboxArgs(state: ViewRootState): InboxArg[] {
  return api.util.selectCachedArgsForQuery(state, "getInbox");
}

function cachedRows(state: ViewRootState, arg: InboxArg): readonly InboxEntry[] {
  return api.endpoints.getInbox.select(arg)(state).data?.rows ?? [];
}

/** Rows for `keys` wherever the entries list them, at the top level or inside a group. */
function rowsFor(entries: readonly InboxEntry[], keys: ReadonlySet<string>): Record<string, InboxRow> {
  const rows: Record<string, InboxRow> = {};
  for (const entry of entries) {
    for (const row of isGroup(entry) ? entry.members : [entry]) {
      if (keys.has(row.key)) rows[row.key] = row;
    }
  }
  return rows;
}

type Dispatch = ThunkDispatch<unknown, unknown, UnknownAction>;

/** Keeps the selection on the entry that took the place of one that left the list. */
function pinSelection(dispatch: Dispatch, getState: () => unknown, selected: InboxEntry | null, index: number) {
  if (!selected) return;
  const visible = selectVisibleRows(getState() as ViewRootState);
  const key = entryKey(selected);
  if (visible.some((entry) => entryKey(entry) === key)) return;
  const next = resolveSelection(visible, key, index);
  if (next) dispatch(rowSelected({ key: entryKey(next), index: visible.indexOf(next) }));
}

function selectionBefore(state: ViewRootState) {
  const selected = selectSelectedEntry(state);
  return { selected, index: selected ? selectVisibleRows(state).indexOf(selected) : 0 };
}

export const stateApi = api.injectEndpoints({
  endpoints: (build) => ({
    applyState: build.mutation<StateResponse, StateRequest>({
      query: (body) => ({ url: "state", method: "POST", body }),
      async onQueryStarted({ keys, op }, { dispatch, getState, queryFulfilled }) {
        const before = getState() as ViewRootState;
        const { selected, index: selectedIndex } = selectionBefore(before);
        const now = new Date().toISOString();
        const keySet = new Set<string>(keys);
        const lingering = before.view.lingering.filter((row) => keySet.has(row.key));

        if (op.kind !== "read" && op.kind !== "unread") dispatch(lingeringDropped(keys));
        // Rollback puts back only these rows, so changes that land meanwhile survive a failure.
        const originals = cachedInboxArgs(before).map((arg) => ({ arg, rows: rowsFor(cachedRows(before, arg), keySet) }));
        for (const { arg } of originals) {
          dispatch(
            api.util.updateQueryData("getInbox", arg, (draft) =>
              patchInbox(asPayload(draft), keys, op, now, { includeHidden: arg.includeHidden }),
            ),
          );
        }

        if (op.kind !== "read") pinSelection(dispatch, getState, selected, selectedIndex);

        const label = opLabel(op, keys.length);
        try {
          const { data } = await queryFulfilled;
          for (const arg of cachedInboxArgs(getState() as ViewRootState)) {
            dispatch(
              api.util.updateQueryData("getInbox", arg, (draft) =>
                replaceRows(asPayload(draft), data.rows, arg.includeHidden),
              ),
            );
          }
          if (op.kind === "read") return;
          dispatch(
            undoPushed({
              opId: data.opId,
              label,
              keys,
              at: now,
              ...(lingering.length > 0 && op.kind !== "unread" ? { lingering } : {}),
            }),
          );
          dispatch(toastShown(label, { opId: data.opId }));
        } catch {
          for (const { arg, rows } of originals) {
            dispatch(
              api.util.updateQueryData("getInbox", arg, (draft) =>
                replaceRows(asPayload(draft), rows, arg.includeHidden),
              ),
            );
          }
          if (op.kind !== "read" && op.kind !== "unread") for (const row of lingering) dispatch(rowRead(row));
          if (op.kind !== "read") dispatch(toastShown(`Could not save: ${label}`, { kind: "error" }));
        }
      },
    }),
    applyWorkstream: build.mutation<WorkstreamStateResponse, WorkstreamStateRequest>({
      query: (body) => ({ url: "state", method: "POST", body }),
      async onQueryStarted({ target, op }, { dispatch, getState, queryFulfilled }) {
        const before = getState() as ViewRootState;
        const { selected, index: selectedIndex } = selectionBefore(before);
        const now = new Date().toISOString();
        const ids = op.kind === "merge" ? [target.id, op.into] : [target.id];
        let name = target.id;

        // Rollback puts back only the touched groups and their member rows.
        const originals = cachedInboxArgs(before).map((arg) => {
          const groups: Record<string, InboxGroup | null> = {};
          const rows: Record<string, InboxRow> = {};
          for (const entry of cachedRows(before, arg)) {
            if (!isGroup(entry) || !ids.includes(entry.id)) continue;
            groups[entry.id] = entry;
            if (entry.id === target.id) name = entry.name;
            for (const member of entry.members) rows[member.key] = member;
          }
          return { arg, groups, rows };
        });
        for (const { arg } of originals) {
          dispatch(
            api.util.updateQueryData("getInbox", arg, (draft) =>
              patchWorkstream(asPayload(draft), target.id, op, now, { includeHidden: arg.includeHidden }),
            ),
          );
        }
        if (op.kind !== "seen") pinSelection(dispatch, getState, selected, selectedIndex);

        const label = workstreamOpLabel(op, name);
        try {
          const { data } = await queryFulfilled;
          for (const arg of cachedInboxArgs(getState() as ViewRootState)) {
            dispatch(
              api.util.updateQueryData("getInbox", arg, (draft) =>
                replaceRows(asPayload(draft), data.rows, arg.includeHidden, data.groups),
              ),
            );
          }
          // Subject previews show the workstream name and summary.
          dispatch(api.util.invalidateTags(ids.map((id) => ({ type: "Workstream" as const, id }))));
          if (op.kind === "seen") return;
          dispatch(undoPushed({ opId: data.opId, label, keys: [], workstream: target.id, at: now }));
          dispatch(toastShown(label, { opId: data.opId }));
        } catch {
          for (const { arg, groups, rows } of originals) {
            dispatch(
              api.util.updateQueryData("getInbox", arg, (draft) =>
                replaceRows(asPayload(draft), rows, arg.includeHidden, groups),
              ),
            );
          }
          if (op.kind !== "seen") dispatch(toastShown(`Could not save: ${label}`, { kind: "error" }));
        }
      },
    }),
    undoState: build.mutation<UndoStateResponse, { opId: number }>({
      query: (body) => ({ url: "state/undo", method: "POST", body }),
      async onQueryStarted({ opId }, { dispatch, getState, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          for (const arg of cachedInboxArgs(getState() as ViewRootState)) {
            dispatch(
              api.util.updateQueryData("getInbox", arg, (draft) =>
                replaceRows(asPayload(draft), data.rows, arg.includeHidden, data.groups ?? {}),
              ),
            );
          }
          const entry = (getState() as ViewRootState).view.undo.find((e) => e.opId === opId);
          if (entry?.workstream) dispatch(api.util.invalidateTags([{ type: "Workstream", id: entry.workstream }]));
          dispatch(undoRemoved(opId));
          for (const row of entry?.lingering ?? []) dispatch(rowRead(row));
          const label = entry?.label ?? "last change";
          const message =
            data.githubApplied === 0
              ? `Undone: ${label}`
              : label.startsWith("Done")
                ? "Undone here. GitHub already marked it done."
                : `Undone here. GitHub already applied: ${label}`;
          dispatch(toastShown(message));
        } catch (error) {
          const refusal = refusalOf(error);
          if (refusal) dispatch(undoRemoved(opId));
          const message =
            refusal === "superseded"
              ? "A newer change on this item; undo that first"
              : refusal === "alreadyUndone"
                ? "Already undone"
                : refusal === "notFound"
                  ? "That change can no longer be undone"
                  : "Could not undo";
          dispatch(toastShown(message, { kind: "error" }));
        }
      },
    }),
    refresh: build.mutation<void, void>({
      query: () => ({ url: "refresh", method: "POST" }),
    }),
  }),
});

/**
 * Applies `op` to `keys`, optimistically; does nothing for an empty list. More than
 * `MAX_STATE_KEYS` keys go as several requests, each its own undo entry.
 */
export function applyState(keys: SubjectKey[], op: StateOp): ViewThunk {
  return (dispatch) => {
    for (let start = 0; start < keys.length; start += MAX_STATE_KEYS) {
      const chunk = keys.slice(start, start + MAX_STATE_KEYS);
      // Results live in the inbox cache and the undo stack, so drop each mutation entry once it settles.
      const request = dispatch(stateApi.endpoints.applyState.initiate({ keys: chunk, op }));
      void request.then(() => request.reset());
    }
  };
}

/** Applies `op` to workstream `id`, optimistically. */
export function applyWorkstream(id: string, op: WorkstreamOp): ViewThunk {
  return (dispatch) => {
    const request = dispatch(stateApi.endpoints.applyWorkstream.initiate({ target: { kind: "workstream", id }, op }));
    void request.then(() => request.reset());
  };
}

export function undoOp(opId: number): ViewThunk {
  return (dispatch) => {
    const request = dispatch(stateApi.endpoints.undoState.initiate({ opId }));
    void request.then(() => request.reset());
  };
}

export function undoLatest(): ViewThunk {
  return (dispatch, getState) => {
    const latest = getState().view.undo[0];
    if (latest) dispatch(undoOp(latest.opId));
    else dispatch(toastShown("Nothing to undo"));
  };
}

export function refreshNow(): ViewThunk {
  return (dispatch) => {
    dispatch(toastShown("Checking GitHub for new notifications…"));
    const request = dispatch(stateApi.endpoints.refresh.initiate());
    request
      .unwrap()
      .catch(() => dispatch(toastShown("Could not request a refresh", { kind: "error" })))
      .finally(() => request.reset());
  };
}
