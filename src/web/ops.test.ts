import { describe, expect, test } from "bun:test";
import { opLabel, shortTime, snoozeChoices } from "./ops.ts";

// A Wednesday, 14:30 local time.
const now = new Date(2026, 10, 25, 14, 30);

describe("snoozeChoices", () => {
  test("offers the presets in order with local 9:00 times", () => {
    const choices = snoozeChoices(now, { draft: false, snoozed: false });
    expect(choices.map((c) => c.label)).toEqual([
      "3 hours",
      "Tomorrow 9:00",
      "Monday 9:00",
      "Until someone replies",
      "Tomorrow 9:00 or when someone replies",
    ]);
    expect(choices[0]?.op).toMatchObject({ until: new Date(2026, 10, 25, 17, 30).toISOString() });
    expect(choices[1]?.op).toMatchObject({ until: new Date(2026, 10, 26, 9).toISOString(), untilHumanEvent: false });
    expect(choices[2]?.op).toMatchObject({ until: new Date(2026, 10, 30, 9).toISOString() });
    expect(choices[3]?.op).toEqual({ kind: "snooze", until: null, untilHumanEvent: true, untilReady: false });
    expect(choices[4]?.op).toMatchObject({ until: new Date(2026, 10, 26, 9).toISOString(), untilHumanEvent: true });
  });

  test("on a Monday, Monday means next week", () => {
    const monday = new Date(2026, 10, 30, 8);
    expect(snoozeChoices(monday, { draft: false, snoozed: false })[2]?.op).toMatchObject({
      until: new Date(2026, 11, 7, 9).toISOString(),
    });
  });

  test("adds ready-for-review for drafts and Unsnooze for snoozed items", () => {
    const labels = snoozeChoices(now, { draft: true, snoozed: true }).map((c) => c.label);
    expect(labels.slice(-2)).toEqual(["Until ready for review", "Unsnooze"]);
  });
});

describe("opLabel", () => {
  test("names the change and counts several items", () => {
    expect(opLabel({ kind: "done" }, 1)).toBe("Done");
    expect(opLabel({ kind: "done" }, 14)).toBe("Done: 14 items");
    expect(opLabel({ kind: "unsubscribe" }, 1)).toBe("Muted and unsubscribed");
    expect(opLabel({ kind: "unread" }, 1)).toBe("Kept unread");
  });

  test("describes each snooze kind", () => {
    const at = new Date(2026, 10, 24, 9).toISOString();
    const snooze = { kind: "snooze" as const, until: null, untilHumanEvent: false, untilReady: false };
    expect(opLabel({ ...snooze, until: at }, 1)).toBe("Snoozed until Tue 9:00");
    expect(opLabel({ ...snooze, untilHumanEvent: true }, 1)).toBe("Snoozed until someone replies");
    expect(opLabel({ ...snooze, until: at, untilHumanEvent: true }, 1)).toBe("Snoozed until Tue 9:00 or someone replies");
    expect(opLabel({ ...snooze, untilReady: true }, 1)).toBe("Snoozed until ready for review");
  });
});

test("shortTime pads minutes", () => {
  expect(shortTime(new Date(2026, 10, 24, 9, 5).toISOString())).toBe("Tue 9:05");
});
