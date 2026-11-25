import { describe, expect, test } from "bun:test";
import { entryKey, type InboxEntry, type InboxPayload, isGroup } from "../../core/index.ts";
import { group, row } from "./__fixtures__/inbox.ts";
import { replaceRows } from "./inbox-cache.ts";

function inbox(rows: InboxEntry[], hidden: number): InboxPayload {
  return {
    rows,
    sidebar: { sections: { waiting: 0, updates: 0, snoozed: 0, hidden }, repos: [] },
    countLines: ["kept as is"],
    generatedAt: "2026-11-01T00:00:00Z",
  };
}

const a = row("acme/app#1", "waiting", "acme/app", { sortAt: "2026-11-02T00:00:00Z" });
const b = row("acme/lib#2", "updates", "acme/lib", { sortAt: "2026-11-01T00:00:00Z" });

describe("replaceRows", () => {
  test("replaces rows in place and recounts sections and repos", () => {
    const result = replaceRows(inbox([a, b], 4), { [b.key]: { ...b, section: "waiting" } }, false);
    expect(result.rows.map((r) => [entryKey(r), r.section])).toEqual([
      ["acme/app#1", "waiting"],
      ["acme/lib#2", "waiting"],
    ]);
    expect(result.sidebar.sections).toEqual({ waiting: 2, updates: 0, snoozed: 0, hidden: 4 });
    expect(result.sidebar.repos).toEqual([
      { repo: "acme/app", waiting: 1, updates: 0 },
      { repo: "acme/lib", waiting: 1, updates: 0 },
    ]);
    expect(result.countLines).toEqual(["kept as is"]);
  });

  test("drops rows that became hidden from a cache without Hidden, counting them", () => {
    const result = replaceRows(inbox([a, b], 4), { [a.key]: { ...a, section: "hidden" } }, false);
    expect(result.rows.map(entryKey)).toEqual(["acme/lib#2"]);
    expect(result.sidebar.sections.hidden).toBe(5);
  });

  test("adds rows that came back from Hidden", () => {
    const result = replaceRows(inbox([b], 4), { [a.key]: a }, false);
    expect(result.rows.map(entryKey)).toEqual(["acme/app#1", "acme/lib#2"]);
    expect(result.sidebar.sections.hidden).toBe(3);
  });

  test("keeps hidden rows in a cache that includes Hidden", () => {
    const result = replaceRows(inbox([a, b], 0), { [a.key]: { ...a, section: "hidden" } }, true);
    expect(result.rows.map((r) => [entryKey(r), r.section])).toEqual([
      ["acme/lib#2", "updates"],
      ["acme/app#1", "hidden"],
    ]);
    expect(result.sidebar.sections).toMatchObject({ updates: 1, hidden: 1 });
  });

  test("returns the same payload when nothing changed", () => {
    const payload = inbox([a], 0);
    expect(replaceRows(payload, {}, false)).toBe(payload);
  });

  test("a group snapshot keeps the cached copies of its members and members it lacks", () => {
    const m1 = row("acme/app#11", "updates", "acme/app", { title: "fresh" });
    const m2 = row("acme/app#12", "updates");
    const m3 = row("acme/app#13", "updates");
    const cached = group("g1", [m1, m2, m3]);
    const snapshot = { ...group("g1", [{ ...m1, title: "stale" }, m2]), memberKeys: cached.memberKeys, name: "Renamed" };
    const result = replaceRows(inbox([cached], 0), {}, false, { g1: snapshot });
    const [entry] = result.rows;
    if (!entry || !isGroup(entry)) throw new Error("expected a group");
    expect(entry.name).toBe("Renamed");
    expect(entry.members.map((m) => [m.key, m.title])).toEqual([
      ["acme/app#11", "fresh"],
      ["acme/app#12", m2.title],
      ["acme/app#13", m3.title],
    ]);
  });

  test("a rollback replaces every cached copy of a restored member", () => {
    const m1 = row("acme/app#11", "updates");
    const m2 = row("acme/app#12", "updates");
    const original = group("g1", [m1, m2]);
    const snoozed = { ...m1, section: "snoozed" as const, snoozeUntil: "2026-12-01T00:00:00Z" };
    const patched = inbox([{ ...original, members: [m2] }, snoozed], 0);
    const result = replaceRows(patched, { [m1.key]: m1 }, false, { g1: original });
    expect(result.rows.map(entryKey)).toEqual(["workstream:g1"]);
    const [entry] = result.rows;
    if (!entry || !isGroup(entry)) throw new Error("expected a group");
    expect(entry.members.map((m) => [m.key, m.section])).toEqual([
      ["acme/app#11", "updates"],
      ["acme/app#12", "updates"],
    ]);
    expect(result.sidebar.sections.snoozed).toBe(0);
  });
});
