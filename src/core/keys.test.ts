import { describe, expect, test } from "bun:test";
import { subjectKeyFor } from "./keys.ts";

const repo = "reduxjs/redux-toolkit";
const api = `https://api.github.com/repos/${repo}`;

describe("subjectKeyFor", () => {
  test.each([
    ["pull request", `${api}/pulls/4821`, `${repo}#4821`],
    ["issue", `${api}/issues/17`, `${repo}#17`],
    ["release", `${api}/releases/123456`, `${repo}@9001`],
    ["discussion", `https://github.com/${repo}/discussions/42`, `${repo}@9001`],
    ["check suite", `${api}/check-suites/987654`, `${repo}@9001`],
    ["no subject url", null, `${repo}@9001`],
    ["pull request comment", `${api}/pulls/comments/55`, `${repo}@9001`],
  ])("%s", (_name, subjectUrl, expected) => {
    expect(subjectKeyFor({ id: "9001", repo, subjectUrl })).toBe(expected);
  });
});
