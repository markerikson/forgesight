import { describe, expect, test } from "bun:test";
import type { Workstream } from "../workstreams.ts";
import { buildWorkstreamSummaryRequest, DESCRIPTION_BUDGET, type MemberText } from "./workstream.ts";

const ws: Workstream = {
  id: "acme/app:ws:101",
  repo: "acme/app",
  name: "Auth rewrite",
  nameSource: "title",
  members: ["acme/app#101", "acme/app#102", "acme/app#103"],
  edges: [
    { child: "acme/app#102", parent: "acme/app#101" },
    { child: "acme/app#103", parent: "acme/app#102" },
  ],
  signals: ["stack"],
  author: "mark",
  prefix: null,
  closed: false,
  closedAt: null,
};

function texts(overrides: Partial<Record<number, Partial<MemberText>>> = {}): Map<string, MemberText> {
  const base: MemberText[] = [
    { number: 101, title: "Extract session store", body: "Moves sessions out of the request handler.", isDraft: false, state: "merged" },
    { number: 102, title: "Add token refresh", body: "Refreshes access tokens before they expire.", isDraft: false, state: "open" },
    { number: 103, title: "Remove legacy cookies", body: "", isDraft: true, state: "open" },
  ];
  return new Map(base.map((t) => [`acme/app#${t.number}`, { ...t, ...overrides[t.number] }]));
}

describe("buildWorkstreamSummaryRequest", () => {
  test("lists members base first with state flags", () => {
    const req = buildWorkstreamSummaryRequest(ws, texts());
    expect(req.schemaName).toBe("workstream_summary");
    expect(req.promptVersion).toBe(1);
    expect(req.inputHash).toMatch(/^[0-9a-f]{16}$/);
    expect(req.user).toMatchSnapshot();
    expect(req.system).toMatchSnapshot();
  });

  test("hash changes with titles, descriptions, draft flags and membership", () => {
    const hash = buildWorkstreamSummaryRequest(ws, texts()).inputHash;
    expect(buildWorkstreamSummaryRequest(ws, texts()).inputHash).toBe(hash);
    expect(buildWorkstreamSummaryRequest(ws, texts({ 102: { title: "Add token rotation" } })).inputHash).not.toBe(hash);
    expect(buildWorkstreamSummaryRequest(ws, texts({ 102: { body: "Changed." } })).inputHash).not.toBe(hash);
    expect(buildWorkstreamSummaryRequest(ws, texts({ 103: { isDraft: false } })).inputHash).not.toBe(hash);
    const shorter = { ...ws, members: ws.members.slice(0, 2) };
    expect(buildWorkstreamSummaryRequest(shorter, texts()).inputHash).not.toBe(hash);
  });

  test("the workstream's own name does not feed the hash", () => {
    const hash = buildWorkstreamSummaryRequest(ws, texts()).inputHash;
    expect(buildWorkstreamSummaryRequest({ ...ws, name: "Renamed" }, texts()).inputHash).toBe(hash);
  });

  test("closed workstreams say so", () => {
    const all = texts({ 102: { state: "merged" }, 103: { state: "closed", isDraft: false } });
    const req = buildWorkstreamSummaryRequest({ ...ws, closed: true }, all);
    expect(req.user).toContain("Workstream state: closed");
    expect(req.user).toContain("## #103 Remove legacy cookies [closed]");
  });

  test("missing texts and long descriptions", () => {
    const partial = texts({ 102: { body: "x".repeat(DESCRIPTION_BUDGET) } });
    partial.delete("acme/app#103");
    const req = buildWorkstreamSummaryRequest(ws, partial);
    expect(req.user).toContain("## acme/app#103\n(description not available)");
    expect(req.user).toContain("[description truncated]");
    expect(req.user.length).toBeLessThan(DESCRIPTION_BUDGET);
  });
});
