import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ensureSubjects, storedPulls } from "./subjects.ts";
import { memoryDb } from "./test-db.ts";

const REPO = "octo/stack";

function enrichedPr(db: Database, number: number, state: string, updatedAt: string, raw: object): void {
  const key = `${REPO}#${number}`;
  ensureSubjects(db, [{ subjectKey: key, repo: REPO, number, kind: "pr", origin: "thread" }]);
  db.query(
    `UPDATE subjects SET state = ?, author = 'alice', head_ref = ?, base_ref = 'main', updated_at = ?, raw_json = ?
     WHERE subject_key = ?`,
  ).run(state, `alice/b${number}`, updatedAt, JSON.stringify(raw), key);
}

describe("storedPulls", () => {
  test("reads enriched PRs updated since the cutoff with title, draft and close time", () => {
    const db = memoryDb();
    enrichedPr(db, 1, "MERGED", "2026-11-24T10:00:00Z", {
      title: "Cache: one",
      isDraft: false,
      author: { login: "alice", __typename: "User" },
      mergedAt: "2026-11-24T10:00:00Z",
      closedAt: "2026-11-24T09:59:00Z",
    });
    enrichedPr(db, 2, "OPEN", "2026-11-24T11:00:00Z", { title: "Cache: two", isDraft: true, closedAt: null });
    enrichedPr(db, 3, "CLOSED", "2026-11-01T00:00:00Z", { title: "old", closedAt: "2026-11-01T00:00:00Z" });
    ensureSubjects(db, [{ subjectKey: `${REPO}#4`, repo: REPO, number: 4, kind: "pr", origin: "thread" }]);

    expect(storedPulls(db, REPO, "2026-11-20T00:00:00Z")).toEqual([
      {
        pull: {
          repo: REPO,
          number: 1,
          title: "Cache: one",
          author: "alice",
          authorType: "User",
          headRef: "alice/b1",
          baseRef: "main",
          isDraft: false,
          updatedAt: "2026-11-24T10:00:00Z",
        },
        state: "MERGED",
        closedAt: "2026-11-24T10:00:00Z",
      },
      {
        pull: {
          repo: REPO,
          number: 2,
          title: "Cache: two",
          author: "alice",
          headRef: "alice/b2",
          baseRef: "main",
          isDraft: true,
          updatedAt: "2026-11-24T11:00:00Z",
        },
        state: "OPEN",
        closedAt: null,
      },
    ]);
    expect(storedPulls(db, "octo/other", "2026-11-20T00:00:00Z")).toEqual([]);
  });
});
