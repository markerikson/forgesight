import { describe, expect, test } from "bun:test";
import type { InboxPayload, InboxRow } from "../../core/index.ts";
import { row } from "./__fixtures__/inbox.ts";
import { replaceRows } from "./inbox-cache.ts";

function inbox(rows: InboxRow[], hidden: number): InboxPayload {
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
    expect(result.rows.map((r) => [r.key, r.section])).toEqual([
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
    expect(result.rows.map((r) => r.key)).toEqual(["acme/lib#2"]);
    expect(result.sidebar.sections.hidden).toBe(5);
  });

  test("adds rows that came back from Hidden", () => {
    const result = replaceRows(inbox([b], 4), { [a.key]: a }, false);
    expect(result.rows.map((r) => r.key)).toEqual(["acme/app#1", "acme/lib#2"]);
    expect(result.sidebar.sections.hidden).toBe(3);
  });

  test("keeps hidden rows in a cache that includes Hidden", () => {
    const result = replaceRows(inbox([a, b], 0), { [a.key]: { ...a, section: "hidden" } }, true);
    expect(result.rows.map((r) => [r.key, r.section])).toEqual([
      ["acme/lib#2", "updates"],
      ["acme/app#1", "hidden"],
    ]);
    expect(result.sidebar.sections).toMatchObject({ updates: 1, hidden: 1 });
  });

  test("returns the same payload when nothing changed", () => {
    const payload = inbox([a], 0);
    expect(replaceRows(payload, {}, false)).toBe(payload);
  });
});
