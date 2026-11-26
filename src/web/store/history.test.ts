import { describe, expect, test } from "bun:test";
import { asNavigation, takeHistoryPush } from "./history.ts";

describe("history push", () => {
  test("only a navigation adds an entry", () => {
    expect(takeHistoryPush()).toBe(false);
  });

  test("a navigation adds one entry, however many URL changes it makes", () => {
    const pushes = asNavigation(() => {
      const first = takeHistoryPush();
      const nested = asNavigation(() => takeHistoryPush());
      return [first, nested, takeHistoryPush()];
    });
    expect(pushes).toEqual([true, false, false]);
    expect(takeHistoryPush()).toBe(false);
  });

  test("each navigation gets its own entry", () => {
    expect(asNavigation(() => takeHistoryPush())).toBe(true);
    expect(asNavigation(() => takeHistoryPush())).toBe(true);
  });
});
