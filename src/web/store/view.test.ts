import { describe, expect, test } from "bun:test";
import { configureStore } from "@reduxjs/toolkit";
import type { InboxPayload, InboxRow, Section } from "../../core/index.ts";
import { api } from "./api.ts";
import {
  filterRows,
  groupsToggled,
  moveSelection,
  repoCounts,
  repoSelected,
  resolveSelection,
  rowSelected,
  sectionSelected,
  selectRepoCounts,
  selectSelectedRow,
  selectVisibleRows,
  viewSlice,
} from "./view.ts";

function row(key: string, section: Section, repo = "acme/app"): InboxRow {
  return {
    key,
    repo,
    number: 1,
    kind: "pr",
    title: key,
    url: null,
    author: null,
    state: "OPEN",
    draft: false,
    merged: false,
    ciState: null,
    reviewDecision: null,
    latestActor: null,
    section,
    reasons: [],
    summaryLine: "",
    newMeaningfulCount: 0,
    hiddenStats: { pushes: 0, merged: 0, closed: 0 },
    sortAt: "2026-11-01T00:00:00Z",
    snoozeUntil: null,
    unread: false,
    enrichError: null,
    findings: [],
  };
}

function payload(rows: InboxRow[]): InboxPayload {
  return {
    rows,
    sidebar: {
      sections: { waiting: 0, updates: 0, snoozed: 0, hidden: 0 },
      repos: [
        { repo: "acme/app", waiting: 2, updates: 0 },
        { repo: "acme/lib", waiting: 1, updates: 1 },
      ],
    },
    countLines: [],
    generatedAt: "2026-11-01T00:00:00Z",
  };
}

function storeWith(rows: InboxRow[], includeHidden = false) {
  const store = configureStore({
    reducer: { [api.reducerPath]: api.reducer, view: viewSlice.reducer },
    middleware: (gDM) => gDM().concat(api.middleware),
  });
  store.dispatch(
    api.util.upsertQueryEntries([{ endpointName: "getInbox", arg: { includeHidden }, value: payload(rows) }]),
  );
  return store;
}

const rows = [
  row("acme/app#1", "waiting"),
  row("acme/lib#2", "waiting", "acme/lib"),
  row("acme/app#3", "waiting"),
  row("acme/lib#4", "updates", "acme/lib"),
];

describe("filterRows", () => {
  test("keeps the section's rows in payload order", () => {
    expect(filterRows(rows, "waiting", null).map((r) => r.key)).toEqual(["acme/app#1", "acme/lib#2", "acme/app#3"]);
  });

  test("narrows by repo", () => {
    expect(filterRows(rows, "waiting", "acme/app").map((r) => r.key)).toEqual(["acme/app#1", "acme/app#3"]);
  });
});

describe("resolveSelection", () => {
  const visible = filterRows(rows, "waiting", null);

  test("finds the selected key", () => {
    expect(resolveSelection(visible, "acme/app#3", 0)?.key).toBe("acme/app#3");
  });

  test("falls back to the row at the old index when the key is gone", () => {
    expect(resolveSelection(visible, "acme/gone#9", 1)?.key).toBe("acme/lib#2");
  });

  test("clamps the fallback index to the list", () => {
    expect(resolveSelection(visible, "acme/gone#9", 10)?.key).toBe("acme/app#3");
  });

  test("returns null for an empty list", () => {
    expect(resolveSelection([], "acme/app#1", 0)).toBeNull();
  });
});

describe("repoCounts", () => {
  test("uses sidebar counts for waiting and drops empty repos", () => {
    expect(repoCounts(payload(rows), "updates")).toEqual([{ repo: "acme/lib", count: 1 }]);
  });

  test("counts rows for snoozed", () => {
    const snoozed = [row("acme/app#5", "snoozed"), row("acme/app#6", "snoozed")];
    expect(repoCounts(payload(snoozed), "snoozed")).toEqual([{ repo: "acme/app", count: 2 }]);
  });
});

describe("selectors", () => {
  test("selects the first visible row when nothing is selected", () => {
    const store = storeWith(rows);
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#1");
  });

  test("moveSelection walks the visible rows and stops at the ends", () => {
    const store = storeWith(rows);
    store.dispatch(moveSelection(1));
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/lib#2");
    store.dispatch(moveSelection(5));
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#3");
    store.dispatch(moveSelection(-10));
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#1");
  });

  test("selection falls back to a neighbor when the selected row disappears", () => {
    const store = storeWith(rows);
    store.dispatch(rowSelected({ key: "acme/lib#2", index: 1 }));
    store.dispatch(
      api.util.upsertQueryEntries([
        { endpointName: "getInbox", arg: { includeHidden: false }, value: payload(rows.filter((r) => r.key !== "acme/lib#2")) },
      ]),
    );
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#3");
  });

  test("the hidden section reads the includeHidden cache entry", () => {
    const store = storeWith([row("acme/app#7", "hidden")], true);
    expect(selectVisibleRows(store.getState())).toEqual([]);
    store.dispatch(sectionSelected("hidden"));
    expect(selectVisibleRows(store.getState()).map((r) => r.key)).toEqual(["acme/app#7"]);
    expect(selectRepoCounts(store.getState())).toEqual([{ repo: "acme/app", count: 1 }]);
  });
});

describe("sectionSelected", () => {
  test("clears the repo filter, including when the section is unchanged", () => {
    let state = viewSlice.reducer(undefined, repoSelected("acme/app"));
    state = viewSlice.reducer(state, sectionSelected("updates"));
    expect(state).toMatchObject({ section: "updates", repo: null });
    state = viewSlice.reducer(state, repoSelected("acme/app"));
    state = viewSlice.reducer(state, sectionSelected("updates"));
    expect(state.repo).toBeNull();
  });
});

describe("groupsToggled", () => {
  test("expands all when any is collapsed, then collapses all", () => {
    let state = viewSlice.reducer(undefined, groupsToggled(["a"]));
    state = viewSlice.reducer(state, groupsToggled(["a", "b"]));
    expect([...state.expandedGroups].sort()).toEqual(["a", "b"]);
    state = viewSlice.reducer(state, groupsToggled(["a", "b"]));
    expect(state.expandedGroups).toEqual([]);
  });
});
