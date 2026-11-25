import { current, type Draft } from "@reduxjs/toolkit";
import type { InboxPayload, InboxRow, SubjectKey } from "../../core/index.ts";
import { MAX_STATE_KEYS, patchInbox, type StateOp } from "../../core/state.ts";
import type { StateRequest, StateResponse, UndoResponse } from "../../server/handlers/state.ts";
import { opLabel } from "../ops.ts";
import { api, type InboxArg } from "./api.ts";
import { replaceRows } from "./inbox-cache.ts";
import {
  lingeringDropped,
  resolveSelection,
  rowRead,
  rowSelected,
  selectSelectedRow,
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

export const stateApi = api.injectEndpoints({
  endpoints: (build) => ({
    applyState: build.mutation<StateResponse, StateRequest>({
      query: (body) => ({ url: "state", method: "POST", body }),
      async onQueryStarted({ keys, op }, { dispatch, getState, queryFulfilled }) {
        const before = getState() as ViewRootState;
        const selected = selectSelectedRow(before);
        const selectedIndex = selected ? selectVisibleRows(before).indexOf(selected) : 0;
        const now = new Date().toISOString();
        const keySet = new Set<string>(keys);
        const lingering = before.view.lingering.filter((row) => keySet.has(row.key));

        if (op.kind !== "read" && op.kind !== "unread") dispatch(lingeringDropped(keys));
        // Rollback puts back only these rows, so changes that land meanwhile survive a failure.
        const originals = cachedInboxArgs(before).map((arg) => {
          const rows: Record<string, InboxRow> = {};
          for (const row of api.endpoints.getInbox.select(arg)(before).data?.rows ?? []) {
            if (keySet.has(row.key)) rows[row.key] = row;
          }
          return { arg, rows };
        });
        for (const { arg } of originals) {
          dispatch(
            api.util.updateQueryData("getInbox", arg, (draft) =>
              patchInbox(asPayload(draft), keys, op, now, { includeHidden: arg.includeHidden }),
            ),
          );
        }

        // Pin the selection on the row that took the place of one that left the list.
        if (op.kind !== "read" && selected) {
          const after = getState() as ViewRootState;
          const visible = selectVisibleRows(after);
          if (!visible.some((row) => row.key === selected.key)) {
            const next = resolveSelection(visible, selected.key, selectedIndex);
            if (next) dispatch(rowSelected({ key: next.key, index: visible.indexOf(next) }));
          }
        }

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
