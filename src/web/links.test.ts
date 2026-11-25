import { describe, expect, test } from "bun:test";
import { githubUrlForKey, isPlainClick, subjectKeyForUrl } from "./links.ts";

describe("githubUrlForKey", () => {
  test("links numbered subjects and skips thread-only keys", () => {
    expect(githubUrlForKey("acme/app#12")).toBe("https://github.com/acme/app/issues/12");
    expect(githubUrlForKey("acme/app@T_123")).toBeNull();
  });
});

describe("subjectKeyForUrl", () => {
  test("reads PR and issue URLs, with or without a trailing part", () => {
    expect(subjectKeyForUrl("https://github.com/acme/app/pull/7")).toBe("acme/app#7");
    expect(subjectKeyForUrl("https://github.com/acme/app/issues/8#issuecomment-1")).toBe("acme/app#8");
    expect(subjectKeyForUrl("https://github.com/acme/app/pull/7/")).toBe("acme/app#7");
  });

  test("ignores other URLs", () => {
    expect(subjectKeyForUrl("https://github.com/acme/app/pull/7/files")).toBeNull();
    expect(subjectKeyForUrl("https://github.com/acme/app/commit/abc")).toBeNull();
    expect(subjectKeyForUrl("https://example.com/acme/app/pull/7")).toBeNull();
  });
});

describe("isPlainClick", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  test("only an unmodified left click counts", () => {
    expect(isPlainClick(click)).toBe(true);
    expect(isPlainClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false);
  });
});
