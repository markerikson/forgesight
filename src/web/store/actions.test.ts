import { describe, expect, test } from "bun:test";
import { group, row } from "./__fixtures__/inbox.ts";
import { doneKeys } from "./actions.ts";

describe("doneKeys", () => {
  const a = row("acme/app#1", "updates");
  const b = row("acme/app#2", "updates");
  const c = row("acme/app#3", "waiting");

  test("takes loose rows and group members, skipping dimmed rows that already left the list", () => {
    expect(doneKeys([a, group("ws", [b, c])], new Set([b.key]))).toEqual([a.key, c.key]);
  });

  test("skips muted groups in Hidden", () => {
    expect(doneKeys([a, group("ws", [b], { section: "hidden", priority: "muted" })])).toEqual([a.key]);
  });
});
