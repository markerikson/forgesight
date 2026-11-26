import { describe, expect, test } from "bun:test";
import { group, row } from "./__fixtures__/inbox.ts";
import type { UnlistedMember, UnlistedReason } from "../../core/inbox.ts";
import { doneKeys, groupDoneKeys } from "./actions.ts";

describe("doneKeys", () => {
  const a = row("acme/app#1", "updates");
  const b = row("acme/app#2", "updates");
  const c = row("acme/app#3", "waiting");

  test("takes loose rows and group members, skipping dimmed rows that already left the list", () => {
    expect(doneKeys([a, group("ws", [b, c])], new Set([b.key]))).toEqual([a.key, c.key]);
  });

  test("takes only the hidden members of a group in Hidden", () => {
    const hidden = row("acme/app#4", "hidden");
    const muted = group("ws", [b, hidden], { section: "hidden", priority: "muted" });
    expect(doneKeys([a, muted])).toEqual([a.key, hidden.key]);
  });
});

describe("groupDoneKeys", () => {
  const b = row("acme/app#2", "updates");
  const c = row("acme/app#3", "waiting");
  const unlisted = (n: number, why: UnlistedReason): UnlistedMember => ({
    key: `acme/app#${n}`,
    number: n,
    title: `PR ${n}`,
    url: null,
    state: "OPEN",
    draft: false,
    author: null,
    updatedAt: null,
    why,
  });
  const members = [unlisted(4, "hidden"), unlisted(5, "snoozed"), unlisted(6, "noThread")];

  test("takes listed members and unlisted ones with a notification", () => {
    expect(groupDoneKeys(group("ws", [b, c], { unlisted: members }))).toEqual([
      b.key,
      c.key,
      "acme/app#4",
      "acme/app#5",
    ]);
  });

  test("covers a muted group in Hidden with no listed members", () => {
    const muted = group("ws", [], { section: "hidden", priority: "muted", unlisted: members });
    expect(groupDoneKeys(muted)).toEqual(["acme/app#4", "acme/app#5"]);
  });

  test("skips dimmed rows that already left the list", () => {
    expect(groupDoneKeys(group("ws", [b], { unlisted: members }), new Set([b.key, "acme/app#4"]))).toEqual([
      "acme/app#5",
    ]);
  });
});
