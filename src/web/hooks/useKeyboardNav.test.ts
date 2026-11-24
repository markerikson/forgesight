import { describe, expect, test } from "bun:test";
import type { SubjectView } from "../../core/index.ts";
import { isEditable, keyAction, roundGroupIds, type KeyInput } from "./useKeyboardNav.ts";

function key(k: string, extra: Partial<KeyInput> = {}): KeyInput {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra };
}

const fakeTarget = (fields: object) => fields as unknown as EventTarget;

describe("keyAction", () => {
  test("maps the inbox keys", () => {
    expect(keyAction(key("j"), false)).toEqual({ type: "move", delta: 1 });
    expect(keyAction(key("k"), false)).toEqual({ type: "move", delta: -1 });
    expect(keyAction(key("n"), false)).toEqual({ type: "round", delta: 1 });
    expect(keyAction(key("p"), false)).toEqual({ type: "round", delta: -1 });
    expect(keyAction(key("o"), false)).toEqual({ type: "open" });
    expect(keyAction(key("Enter"), false)).toEqual({ type: "open" });
    expect(keyAction(key("x"), false)).toEqual({ type: "toggleGroups" });
    expect(keyAction(key("?"), false)).toEqual({ type: "help" });
    expect(keyAction(key("g"), false)).toEqual({ type: "prefix" });
  });

  test("g then a letter picks a section", () => {
    expect(keyAction(key("w"), true)).toEqual({ type: "section", section: "waiting" });
    expect(keyAction(key("u"), true)).toEqual({ type: "section", section: "updates" });
    expect(keyAction(key("s"), true)).toEqual({ type: "section", section: "snoozed" });
    expect(keyAction(key("j"), true)).toBeNull();
  });

  test("ignores modified keys and unknown keys", () => {
    expect(keyAction(key("j", { ctrlKey: true }), false)).toBeNull();
    expect(keyAction(key("j", { metaKey: true }), false)).toBeNull();
    expect(keyAction(key("q"), false)).toBeNull();
  });

  test("ignores typing in text fields", () => {
    expect(keyAction(key("j", { target: fakeTarget({ tagName: "INPUT", type: "text" }) }), false)).toBeNull();
    expect(keyAction(key("j", { target: fakeTarget({ tagName: "TEXTAREA" }) }), false)).toBeNull();
    expect(keyAction(key("j", { target: fakeTarget({ tagName: "DIV", isContentEditable: true }) }), false)).toBeNull();
    expect(keyAction(key("j", { target: fakeTarget({ tagName: "INPUT", type: "checkbox" }) }), false)).toEqual({
      type: "move",
      delta: 1,
    });
  });

  test("leaves Enter and Space alone on buttons and links", () => {
    expect(keyAction(key("Enter", { target: fakeTarget({ tagName: "BUTTON" }) }), false)).toBeNull();
    expect(keyAction(key("Enter", { target: fakeTarget({ tagName: "A" }) }), false)).toBeNull();
    expect(keyAction(key(" ", { target: fakeTarget({ tagName: "BUTTON" }) }), false)).toBeNull();
    expect(keyAction(key("o", { target: fakeTarget({ tagName: "BUTTON" }) }), false)).toEqual({ type: "open" });
  });

  test("maps the state change keys", () => {
    expect(keyAction(key("e"), false)).toEqual({ type: "done" });
    expect(keyAction(key("m"), false)).toEqual({ type: "mute" });
    expect(keyAction(key("M"), false)).toEqual({ type: "unsubscribe" });
    expect(keyAction(key("s"), false)).toEqual({ type: "snooze" });
    expect(keyAction(key("z"), false)).toEqual({ type: "snooze" });
    expect(keyAction(key("u"), false)).toEqual({ type: "toggleUnread" });
    expect(keyAction(key("Z"), false)).toEqual({ type: "undo" });
    expect(keyAction(key(" "), false)).toEqual({ type: "next" });
    expect(keyAction(key("R"), false)).toEqual({ type: "refresh" });
  });

  test("routes keys to the snooze menu while it is open", () => {
    expect(keyAction(key("1"), false, true)).toEqual({ type: "menuPick", index: 0 });
    expect(keyAction(key("6"), false, true)).toEqual({ type: "menuPick", index: 5 });
    expect(keyAction(key("ArrowDown"), false, true)).toEqual({ type: "menuMove", delta: 1 });
    expect(keyAction(key("k"), false, true)).toEqual({ type: "menuMove", delta: -1 });
    expect(keyAction(key("Enter"), false, true)).toEqual({ type: "menuChoose" });
    expect(keyAction(key("Escape"), false, true)).toEqual({ type: "menuClose" });
    expect(keyAction(key("e"), false, true)).toBeNull();
    expect(keyAction(key("0"), false, true)).toBeNull();
  });
});

test("isEditable treats null as not editable", () => {
  expect(isEditable(null)).toBe(false);
});

test("roundGroupIds lists the groups of one round", () => {
  const event = (id: string) => ({
    id,
    at: "2026-11-01T00:00:00Z",
    actor: null,
    kind: "commit" as const,
    data: { typename: "PullRequestCommit" },
    level: "collapsed" as const,
    isNew: false,
  });
  const subject = {
    key: "acme/app#1",
    rounds: [
      {
        startedBy: null,
        startLabel: null,
        startedAt: "2026-11-01T00:00:00Z",
        hiddenCount: 0,
        isNew: false,
        entries: [
          { type: "event", event: event("e1") },
          { type: "group", group: { summary: "2 commits", items: [event("c1"), event("c2")], isNew: false } },
        ],
      },
    ],
  } as unknown as SubjectView;
  expect(roundGroupIds(subject, 0)).toEqual(["acme/app#1:c1"]);
  expect(roundGroupIds(subject, 1)).toEqual([]);
});
