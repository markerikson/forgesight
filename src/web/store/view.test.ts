import { describe, expect, test } from "bun:test";
import { entryKey } from "../../core/index.ts";
import { api } from "./api.ts";
import { group, payload, row, storeWith } from "./__fixtures__/inbox.ts";
import {
  filterRows,
  flattenEntries,
  MEMBER_CAP,
  selectGroupOf,
  selectSelectedEntry,
  selectSelectedGroup,
  selectSubject,
  toggleWorkstream,
  groupsToggled,
  lingeringDropped,
  moveSelection,
  openSubject,
  repoCounts,
  repoSelected,
  resolveSelection,
  rowRead,
  rowSelected,
  sectionSelected,
  selectGoneKeys,
  selectRepoCounts,
  selectSelectedRow,
  selectVisibleRows,
  snoozeMenuMoved,
  snoozeMenuOpened,
  toastDismissed,
  toastShown,
  UNDO_LIMIT,
  undoPushed,
  undoRemoved,
  viewSlice,
  withLingering,
} from "./view.ts";

const rows = [
  row("acme/app#1", "waiting"),
  row("acme/lib#2", "waiting", "acme/lib"),
  row("acme/app#3", "waiting"),
  row("acme/lib#4", "updates", "acme/lib"),
];

describe("filterRows", () => {
  test("keeps the section's rows in payload order", () => {
    expect(filterRows(rows, "waiting", null).map(entryKey)).toEqual(["acme/app#1", "acme/lib#2", "acme/app#3"]);
  });

  test("narrows by repo", () => {
    expect(filterRows(rows, "waiting", "acme/app").map(entryKey)).toEqual(["acme/app#1", "acme/app#3"]);
  });
});

describe("resolveSelection", () => {
  const visible = filterRows(rows, "waiting", null);
  const pick = (key: string | null, index: number) => {
    const entry = resolveSelection(visible, key, index);
    return entry ? entryKey(entry) : null;
  };

  test("finds the selected key", () => {
    expect(pick("acme/app#3", 0)).toBe("acme/app#3");
  });

  test("falls back to the row at the old index when the key is gone", () => {
    expect(pick("acme/gone#9", 1)).toBe("acme/lib#2");
  });

  test("clamps the fallback index to the list", () => {
    expect(pick("acme/gone#9", 10)).toBe("acme/app#3");
  });

  test("returns null when nothing is selected", () => {
    expect(resolveSelection(visible, null, 0)).toBeNull();
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
  test("selects nothing until a row is picked", () => {
    const store = storeWith(rows);
    expect(selectSelectedRow(store.getState())).toBeNull();
    store.dispatch(sectionSelected("updates"));
    expect(selectSelectedRow(store.getState())).toBeNull();
  });

  test("moveSelection starts at the first row and stops at the ends", () => {
    const store = storeWith(rows);
    store.dispatch(moveSelection(1));
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#1");
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
    expect(selectVisibleRows(store.getState()).map(entryKey)).toEqual(["acme/app#7"]);
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

describe("lingering rows", () => {
  const live = [
    row("acme/app#1", "updates", "acme/app", { sortAt: "2026-11-03T00:00:00Z" }),
    row("acme/app#3", "updates", "acme/app", { sortAt: "2026-11-01T00:00:00Z" }),
  ];
  const read = row("acme/app#2", "updates", "acme/app", { sortAt: "2026-11-02T00:00:00Z" });

  test("withLingering keeps read rows in their sort position", () => {
    expect(withLingering(live, [read], "updates", null).map(entryKey)).toEqual([
      "acme/app#1",
      "acme/app#2",
      "acme/app#3",
    ]);
  });

  test("withLingering prefers the live row and respects the section and repo filter", () => {
    expect(withLingering(live, [{ ...live[0]!, title: "old" }], "updates", null)[0]).toBe(live[0]);
    expect(withLingering(live, [read], "waiting", null)).toEqual([]);
    expect(withLingering(live, [read], "updates", "acme/lib")).toEqual([]);
  });

  test("a read row stays listed and dimmed after the inbox drops it", () => {
    const store = storeWith([...live, read]);
    store.dispatch(sectionSelected("updates"));
    store.dispatch(rowRead(read));
    store.dispatch(api.util.upsertQueryEntries([{ endpointName: "getInbox", arg: { includeHidden: false }, value: payload(live) }]));
    expect(selectVisibleRows(store.getState()).map(entryKey)).toContain("acme/app#2");
    expect([...selectGoneKeys(store.getState())]).toEqual(["acme/app#2"]);
  });

  test("changing section or repo clears lingering rows", () => {
    let state = viewSlice.reducer(undefined, rowRead(read));
    state = viewSlice.reducer(state, repoSelected("acme/app"));
    expect(state.lingering).toEqual([]);
    state = viewSlice.reducer(state, rowRead(read));
    state = viewSlice.reducer(state, sectionSelected("snoozed"));
    expect(state.lingering).toEqual([]);
  });

  test("lingeringDropped removes only the given keys", () => {
    let state = viewSlice.reducer(undefined, rowRead(read));
    state = viewSlice.reducer(state, rowRead(live[0]!));
    state = viewSlice.reducer(state, lingeringDropped(["acme/app#2"]));
    expect(state.lingering.map(entryKey)).toEqual(["acme/app#1"]);
  });
});

describe("undo stack and toast", () => {
  const entry = (n: number) => ({ opId: n, label: "Done", keys: [`acme/app#${n}`], at: "2026-11-01T00:00:00Z" });

  test("keeps the newest entries first, up to the limit", () => {
    let state = viewSlice.reducer(undefined, undoPushed(entry(0)));
    for (let n = 1; n <= UNDO_LIMIT; n++) state = viewSlice.reducer(state, undoPushed(entry(n)));
    expect(state.undo).toHaveLength(UNDO_LIMIT);
    expect(state.undo[0]?.opId).toBe(UNDO_LIMIT);
    expect(state.undo.some((e) => e.opId === 0)).toBe(false);
  });

  test("removing an entry also closes its toast", () => {
    let state = viewSlice.reducer(undefined, undoPushed(entry(1)));
    state = viewSlice.reducer(state, toastShown("Done", { opId: 1 }));
    state = viewSlice.reducer(state, undoRemoved(1));
    expect(state.undo).toEqual([]);
    expect(state.toast).toBeNull();
  });

  test("a stale timer does not dismiss a newer toast", () => {
    let state = viewSlice.reducer(undefined, toastShown("first"));
    const firstId = state.toast!.id;
    state = viewSlice.reducer(state, toastShown("second", { kind: "error" }));
    state = viewSlice.reducer(state, toastDismissed(firstId));
    expect(state.toast).toMatchObject({ message: "second", kind: "error" });
    state = viewSlice.reducer(state, toastDismissed(undefined));
    expect(state.toast).toBeNull();
  });
});

test("snoozeMenuMoved wraps around the choices", () => {
  let state = viewSlice.reducer(
    undefined,
    snoozeMenuOpened({ keys: ["acme/app#1"], draft: false, snoozed: false, anchor: null }),
  );
  state = viewSlice.reducer(state, snoozeMenuMoved({ delta: -1, count: 5 }));
  expect(state.snoozeMenu?.index).toBe(4);
  state = viewSlice.reducer(state, snoozeMenuMoved({ delta: 1, count: 5 }));
  expect(state.snoozeMenu?.index).toBe(0);
});

describe("workstream groups", () => {
  const members = Array.from({ length: 10 }, (_, i) =>
    row(`acme/app#${10 + i}`, "updates", "acme/app", { sortAt: `2026-11-0${(i % 9) + 1}T00:00:00Z` }),
  );
  const stack = group("s1", members);
  const loose = row("acme/app#1", "waiting");
  const entries = [loose, stack];

  test("flattenEntries lists members after an expanded group, capped until shown in full", () => {
    expect(flattenEntries(entries, [], []).map(entryKey)).toEqual(["acme/app#1", "workstream:s1"]);
    const capped = flattenEntries(entries, ["s1"], []);
    expect(capped).toHaveLength(2 + MEMBER_CAP);
    expect(flattenEntries(entries, ["s1"], ["s1"])).toHaveLength(2 + members.length);
  });

  test("withLingering puts a read member back inside its group, in stack order", () => {
    const live = group("s1", [members[0]!, members[2]!], {
      memberKeys: members.slice(0, 3).map((m) => m.key),
      moreCount: 1,
      unlisted: [
        {
          key: members[1]!.key,
          number: members[1]!.number,
          title: members[1]!.title,
          url: null,
          state: null,
          draft: false,
          author: null,
          updatedAt: null,
          why: "hidden",
        },
      ],
    });
    const result = withLingering([live], [members[1]!], "updates", null);
    expect("unlisted" in result[0]! ? result[0].unlisted : null).toEqual([]);
    expect(result.map(entryKey)).toEqual(["workstream:s1"]);
    const joined = result[0]!;
    expect("members" in joined ? joined.members.map((m) => m.key) : []).toEqual(
      members.slice(0, 3).map((m) => m.key),
    );
    expect("moreCount" in joined ? joined.moreCount : -1).toBe(0);
  });

  test("withLingering joins a read member whose row already moved to Hidden", () => {
    const live = group("s1", [members[0]!], { memberKeys: members.slice(0, 2).map((m) => m.key) });
    const read = { ...members[1]!, section: "hidden" as const };
    const other = row("acme/app#2", "hidden");
    const result = withLingering([live], [read, other], "updates", null);
    expect(result.map(entryKey)).toEqual(["workstream:s1"]);
    expect("members" in result[0]! ? result[0].members.map((m) => m.key) : []).toEqual(
      members.slice(0, 2).map((m) => m.key),
    );
  });

  test("resolveSelection maps a member of a collapsed group to the group row", () => {
    expect(resolveSelection(entries, members[3]!.key, 0)).toBe(stack);
  });

  test("selecting a group row exposes it as the selected group, not a row", () => {
    const store = storeWith(entries);
    store.dispatch(sectionSelected("updates"));
    store.dispatch(rowSelected({ key: "workstream:s1", index: 0 }));
    expect(selectSelectedGroup(store.getState())?.id).toBe("s1");
    expect(selectSelectedRow(store.getState())).toBeNull();
  });

  test("collapsing while a member is selected moves selection to the group", () => {
    const store = storeWith(entries);
    store.dispatch(sectionSelected("updates"));
    store.dispatch(toggleWorkstream("s1", true));
    store.dispatch(rowSelected({ key: "acme/app#12", index: 3 }));
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#12");
    store.dispatch(toggleWorkstream("s1", false));
    expect(selectSelectedEntry(store.getState()) && entryKey(selectSelectedEntry(store.getState())!)).toBe("workstream:s1");
  });

  test("selectSubject expands the member's group in full and selects it", () => {
    const store = storeWith(entries);
    store.dispatch(sectionSelected("updates"));
    expect(store.dispatch(selectSubject("acme/app#19"))).toBe(true);
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#19");
    expect(store.dispatch(selectSubject("acme/app#99"))).toBe(false);
  });

  test("openSubject switches section and clears the repo filter to select the subject", () => {
    const store = storeWith(entries);
    store.dispatch(sectionSelected("updates"));
    store.dispatch(repoSelected("acme/lib"));
    expect(store.dispatch(openSubject("acme/app#1"))).toBe(true);
    expect(store.getState().view).toMatchObject({ section: "waiting", repo: null });
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#1");
  });

  test("openSubject returns false for a subject the inbox does not have", () => {
    const store = storeWith(entries);
    expect(store.dispatch(openSubject("acme/app#99"))).toBe(false);
    expect(store.getState().view.section).toBe("waiting");
  });

  test("openSubject goes to the group's section, not the member's own", () => {
    const waiting = group("s3", [row("acme/app#40", "waiting"), row("acme/app#41", "updates")]);
    const store = storeWith([waiting]);
    store.dispatch(sectionSelected("updates"));
    expect(store.dispatch(openSubject("acme/app#41"))).toBe(true);
    expect(store.getState().view.section).toBe("waiting");
    expect(selectSelectedRow(store.getState())?.key).toBe("acme/app#41");
  });

  test("openSubject waits for a hidden member's section to load", () => {
    const hidden = {
      key: "acme/app#30",
      number: 30,
      title: "read one",
      url: null,
      state: "OPEN" as const,
      draft: false,
      author: null,
      updatedAt: null,
      why: "hidden" as const,
    };
    const store = storeWith([group("s2", [members[0]!], { unlisted: [hidden] })]);
    expect(store.dispatch(openSubject("acme/app#30"))).toBe(true);
    expect(store.getState().view).toMatchObject({ section: "hidden", selectedKey: "acme/app#30" });
  });

  test("members count as listed for gone keys", () => {
    const store = storeWith(entries);
    store.dispatch(sectionSelected("updates"));
    store.dispatch(rowRead(members[0]!));
    expect([...selectGoneKeys(store.getState())]).toEqual([]);
    expect(selectGroupOf(store.getState()).get("acme/app#10")?.id).toBe("s1");
  });
});
