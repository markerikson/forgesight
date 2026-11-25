import { current, type Draft, type ThunkDispatch, type UnknownAction } from "@reduxjs/toolkit";
import type { InboxPayload, InboxRow, SubjectKey } from "../../core/index.ts";
import { entryKey, type InboxEntry, type InboxGroup, isGroup } from "../../core/inbox.ts";
import { MAX_STATE_KEYS, patchInbox, patchWorkstream, type StateOp } from "../../core/state.ts";
import type { WorkstreamOp } from "../../core/workstream-state.ts";
import type { StateRequest, StateResponse, UndoResponse } from "../../server/handlers/state.ts";
import type { RefreshResponse } from "../../server/handlers/subject.ts";
import type { WorkstreamStateRequest, WorkstreamStateResponse } from "../../server/handlers/workstreams.ts";
import { opLabel, workstreamOpLabel } from "../ops.ts";
import { api, type InboxArg, subjectPath } from "./api.ts";
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

type UndoStateResponse = Extract<UndoResponse, { result: "undone" }>;
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

/** Groups that list any of `keys` among their members. */
function groupsFor(entries: readonly InboxEntry[], keys: ReadonlySet<string>): Record<string, InboxGroup> {
  const groups: Record<string, InboxGroup> = {};
  for (const entry of entries) {
    if (isGroup(entry) && entry.members.some((member) => keys.has(member.key))) groups[entry.id] = entry;
  }
  return groups;
}

function workstreamTags(ids: readonly string[], withInbox: boolean) {
  const tags = ids.map((id) => ({ type: "Workstream" as const, id }));
  return withInbox ? [...tags, { type: "Inbox" as const, id: "LIST" }] : tags;
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

/**
 * A rolled-back group the cache no longer lists may have left as Hidden (one entry) or been
 * dropped empty (its members counted one by one), so only the server knows the Hidden count.
 */
function refetchAfterGroupRollback(
  dispatch: Dispatch,
  originals: readonly { groups: Readonly<Record<string, InboxGroup | null>> }[],
) {
  if (originals.some(({ groups }) => Object.keys(groups).length > 0)) {
    dispatch(api.util.invalidateTags([{ type: "Inbox", id: "LIST" }]));
  }
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
        // Groups holding these rows come back too: the patch can empty a group and drop it.
        const originals = cachedInboxArgs(before).map((arg) => {
          const entries = cachedRows(before, arg);
          return { arg, rows: rowsFor(entries, keySet), groups: groupsFor(entries, keySet) };
        });
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
          for (const { arg, rows, groups } of originals) {
            dispatch(
              api.util.updateQueryData("getInbox", arg, (draft) =>
                replaceRows(asPayload(draft), rows, arg.includeHidden, groups),
              ),
            );
          }
          refetchAfterGroupRollback(dispatch, originals);
          if (op.kind !== "read" && op.kind !== "unread") for (const row of lingering) dispatch(rowRead(row));
          if (op.kind !== "read") dispatch(toastShown(`Could not save: ${label}`, { kind: "error" }));
        }
      },
    }),
    applyWorkstream: build.mutation<WorkstreamStateResponse, WorkstreamStateRequest>({
      query: (body) => ({ url: "workstreams/state", method: "POST", body }),
      async onQueryStarted({ id: targetId, op }, { dispatch, getState, queryFulfilled }) {
        const before = getState() as ViewRootState;
        const { selected, index: selectedIndex } = selectionBefore(before);
        const now = new Date().toISOString();
        const ids = op.kind === "merge" ? [targetId, op.from] : [targetId];
        let name = targetId;

        // Rollback puts back only the touched groups and their member rows.
        const originals = cachedInboxArgs(before).map((arg) => {
          const groups: Record<string, InboxGroup | null> = {};
          const rows: Record<string, InboxRow> = {};
          for (const entry of cachedRows(before, arg)) {
            if (!isGroup(entry) || !ids.includes(entry.id)) continue;
            groups[entry.id] = entry;
            if (entry.id === targetId) name = entry.name;
            for (const member of entry.members) rows[member.key] = member;
          }
          return { arg, groups, rows };
        });
        for (const { arg } of originals) {
          dispatch(
            api.util.updateQueryData("getInbox", arg, (draft) =>
              patchWorkstream(asPayload(draft), targetId, op, now, { includeHidden: arg.includeHidden }),
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
                replaceRows(asPayload(draft), data.rows, arg.includeHidden),
              ),
            );
          }
          // The response carries stored workstreams, not inbox groups, so refetch the groups.
          // Subject previews show the workstream name and summary too.
          dispatch(api.util.invalidateTags(workstreamTags(ids, op.kind !== "seen")));
          if (op.kind === "seen") return;
          dispatch(undoPushed({ opId: data.opId, label, keys: [], workstream: targetId, at: now }));
          dispatch(toastShown(label, { opId: data.opId }));
        } catch {
          for (const { arg, groups, rows } of originals) {
            dispatch(
              api.util.updateQueryData("getInbox", arg, (draft) =>
                replaceRows(asPayload(draft), rows, arg.includeHidden, groups),
              ),
            );
          }
          refetchAfterGroupRollback(dispatch, originals);
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
                replaceRows(asPayload(draft), data.rows, arg.includeHidden),
              ),
            );
          }
          const entry = (getState() as ViewRootState).view.undo.find((e) => e.opId === opId);
          if (data.workstreams) dispatch(api.util.invalidateTags(workstreamTags(Object.keys(data.workstreams), true)));
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
    refreshSubject: build.mutation<RefreshResponse, { key: SubjectKey; ifNeeded?: boolean }>({
      query: ({ key, ifNeeded }) => ({
        url: `subjects/${subjectPath(key)}/refresh${ifNeeded ? "?ifNeeded=1" : ""}`,
        method: "POST",
      }),
      // The preview polls the subject while it is fetching, and the worker's change event
      // refetches it once the fetch lands.
      async onQueryStarted({ key, ifNeeded }, { dispatch, queryFulfilled }) {
        if (ifNeeded) return;
        const patch = dispatch(
          api.util.updateQueryData("getSubject", key, (draft) => {
            draft.fetching = true;
          }),
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
          dispatch(toastShown("Could not refresh this thread", { kind: "error" }));
        }
      },
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
    const request = dispatch(stateApi.endpoints.applyWorkstream.initiate({ id, op }));
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

/** Fetches one subject from GitHub ahead of the rest of the queue. */
export function refreshSubject(key: SubjectKey): ViewThunk {
  return (dispatch) => {
    const request = dispatch(stateApi.endpoints.refreshSubject.initiate({ key }));
    void request.then(() => request.reset());
  };
}

/**
 * Queues an opened subject for an urgent fetch when it was never fetched, lacks its description,
 * or has newer activity. Reading the subject does not queue it, because the list prefetches
 * neighbors through the same request.
 */
export function openSubject(key: SubjectKey): ViewThunk {
  return (dispatch) => {
    const request = dispatch(stateApi.endpoints.refreshSubject.initiate({ key, ifNeeded: true }));
    void request.then(() => request.reset());
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
