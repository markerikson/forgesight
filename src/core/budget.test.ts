import { describe, expect, test } from "bun:test";
import { type BudgetState, type WorkClass, decideAllowed } from "./budget.ts";

const now = new Date("2026-11-23T12:00:00Z");
const later = new Date("2026-11-23T12:30:00Z");
const earlier = new Date("2026-11-23T11:30:00Z");

const all: WorkClass[] = ["notifications", "enrich", "writeback", "openPulls", "rebase", "doneSync", "backfill"];
const soft: WorkClass[] = ["notifications", "enrich", "writeback"];
const essential: WorkClass[] = ["notifications", "writeback"];

function state(overrides: Partial<BudgetState>): BudgetState {
  return { spend: 0, cap: 1000, remaining: null, pausedUntil: null, ...overrides };
}

describe("decideAllowed", () => {
  test.each<[string, Partial<BudgetState>, WorkClass[]]>([
    ["no spend", {}, all],
    ["just under 80%", { spend: 799 }, all],
    ["at 80%", { spend: 800 }, soft],
    ["just under cap", { spend: 999 }, soft],
    ["at cap", { spend: 1000 }, essential],
    ["over cap", { spend: 1500 }, essential],
    ["plenty remaining", { remaining: { remaining: 4000, resetAt: later } }, all],
    ["low remaining", { remaining: { remaining: 499, resetAt: later } }, essential],
    ["low remaining after reset", { remaining: { remaining: 10, resetAt: earlier } }, all],
    ["low remaining and over cap", { spend: 2000, remaining: { remaining: 3, resetAt: later } }, essential],
    ["quota exhausted", { remaining: { remaining: 0, resetAt: later } }, []],
    ["quota exhausted after reset", { remaining: { remaining: 0, resetAt: earlier } }, all],
    ["paused", { pausedUntil: later }, []],
    ["pause ended", { pausedUntil: earlier }, all],
    ["paused overrides everything", { spend: 1000, pausedUntil: later }, []],
  ])("%s", (_name, overrides, expected) => {
    expect([...decideAllowed(state(overrides), now)].sort()).toEqual([...expected].sort());
  });
});
