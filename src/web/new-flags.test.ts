import { expect, test } from "bun:test";
import type { Round, SubjectDetail, ViewEvent } from "../core/index.ts";
import { keepNewFlags } from "./new-flags.ts";

function event(id: string, isNew: boolean): ViewEvent {
  return { id, at: "2026-11-01T00:00:00Z", actor: null, kind: "comment", data: { typename: "IssueComment" }, level: "show", isNew };
}

function round(events: ViewEvent[], grouped: ViewEvent[] = []): Round {
  return {
    startedBy: null,
    startLabel: null,
    startedAt: "2026-11-01T00:00:00Z",
    pushCount: 0,
    commits: [],
    entries: [
      ...events.map((e) => ({ type: "event" as const, event: e })),
      ...(grouped.length > 0
        ? [{ type: "group" as const, group: { summary: "bots", items: grouped, isNew: grouped.some((g) => g.isNew) } }]
        : []),
    ],
    hiddenCount: 0,
    isNew: [...events, ...grouped].some((e) => e.isNew),
  };
}

function detail(key: string, rounds: Round[], lastVisitAt: string | null): SubjectDetail {
  return { key, rounds, lastVisitAt } as unknown as SubjectDetail;
}

const base = detail("acme/app#1", [round([event("old", false), event("new", true)], [event("bot", true)])], "2026-10-30T00:00:00Z");

test("keeps the markers the user saw after the server clears them", () => {
  const fresh = detail("acme/app#1", [round([event("old", false), event("new", false)], [event("bot", false)])], "2026-11-24T00:00:00Z");
  const kept = keepNewFlags(base, fresh);
  const entries = kept.rounds[0]!.entries;
  expect(entries.map((e) => (e.type === "event" ? e.event.isNew : e.group.isNew))).toEqual([false, true, true]);
  expect(kept.rounds[0]!.isNew).toBe(true);
  expect(kept.lastVisitAt).toBe("2026-10-30T00:00:00Z");
});

test("events that arrived while reading count as new", () => {
  const fresh = detail("acme/app#1", [round([event("late", false)]), round([event("old", false), event("new", false)])], null);
  const kept = keepNewFlags(base, fresh);
  expect(kept.rounds.map((r) => r.isNew)).toEqual([true, true]);
});

test("leaves another subject untouched", () => {
  const other = detail("acme/app#2", [round([event("x", false)])], null);
  expect(keepNewFlags(base, other)).toBe(other);
});
