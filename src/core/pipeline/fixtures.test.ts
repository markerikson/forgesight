import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../../config/load.ts";
import type {
  EnrichmentResult,
  ItemState,
  StickyCommentVersion,
  SubjectRecord,
  ThreadRecord,
  TimelineItemRecord,
} from "../types.ts";
import { type DeriveInput, deriveSubjectView } from "./index.ts";
import type { RepoMode } from "../config.ts";
import type { SubjectView } from "./types.ts";

const FIXTURES = join(import.meta.dir, "..", "__fixtures__");
const ME = "markerikson";
const UPDATE = process.env.UPDATE_FIXTURES === "1";

interface FixtureCase {
  subjectKey: string;
  kind: "pr" | "issue";
  mode: RepoMode;
  recordedAt: string;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T;
}

export async function loadFixture(name: string): Promise<DeriveInput> {
  const dir = join(FIXTURES, name, "input");
  const meta = await readJson<FixtureCase>(join(dir, "case.json"));
  const enrichment = await readJson<EnrichmentResult>(join(dir, "enrichment.json"));
  const threads = await readJson<ThreadRecord[]>(join(dir, "threads.json"));
  const repo = meta.subjectKey.split("#")[0] ?? "";
  const number = Number(meta.subjectKey.split("#")[1]);
  const s = enrichment.subject;

  const subject: SubjectRecord = {
    subjectKey: meta.subjectKey,
    repo,
    number,
    kind: meta.kind,
    nodeId: s.nodeId,
    origin: threads.length > 0 ? "thread" : "open-list",
    state: s.state,
    author: s.author,
    headRef: s.headRef,
    baseRef: s.baseRef,
    headSha: s.headSha,
    baseSha: s.baseSha,
    updatedAt: s.updatedAt,
    timelineSyncedUntil: enrichment.timelineSyncedUntil,
    dirtyAt: null,
    priority: 0,
    enrichError: null,
    enrichAttempts: 0,
    raw: s.raw,
  };
  const items: TimelineItemRecord[] = enrichment.timelineItems.map((i) => ({
    ...i,
    subjectKey: meta.subjectKey,
    fetchedAt: meta.recordedAt,
  }));
  const stickies: StickyCommentVersion[] = enrichment.stickies.map((st) => ({
    commentNodeId: st.commentNodeId,
    bodyHash: "",
    subjectKey: meta.subjectKey,
    author: st.author,
    lastEditedAt: st.lastEditedAt,
    seenAt: meta.recordedAt,
    lastSeenAt: meta.recordedAt,
    body: st.body,
  }));
  const state: ItemState = {
    dismissedAt: threads.find((t) => t.lastReadAt !== null)?.lastReadAt ?? null,
    keepUnread: false,
    snoozeUntil: null,
    snoozeUntilHumanEvent: false,
    snoozeUntilReady: false,
    snoozedAt: null,
    doneAt: null,
    muted: false,
  };
  const config = resolveConfig({ me: ME, repos: { [repo]: { mode: meta.mode } } });
  return {
    subject,
    threads,
    items,
    reviewThreads: [],
    stickies,
    state,
    config,
    me: ME,
    now: new Date(meta.recordedAt),
  };
}

/** The parts of a view the fixtures pin down. */
function trim(view: SubjectView) {
  return {
    section: view.section,
    reasons: view.reasons,
    summaryLine: view.summaryLine,
    newMeaningfulCount: view.newMeaningfulCount,
    hiddenStats: view.hiddenStats,
    sortAt: view.sortAt,
    links: view.links,
    rounds: view.rounds.map((r) => ({
      start: r.startLabel,
      isNew: r.isNew,
      hidden: r.hiddenCount,
      entries: r.entries.map((e) =>
        e.type === "event"
          ? `${e.event.kind} ${e.event.actor?.login ?? "-"}${e.event.isNew ? " (new)" : ""} ${e.event.id}`
          : `[${e.group.summary}]${e.group.isNew ? " (new)" : ""}`,
      ),
    })),
  };
}

const cases = readdirSync(FIXTURES).toSorted();

describe("deriveSubjectView fixtures", () => {
  for (const name of cases) {
    test(name, async () => {
      const input = await loadFixture(name);
      const actual = trim(deriveSubjectView(input));
      const expectedPath = join(FIXTURES, name, "expected.json");
      if (UPDATE || !(await Bun.file(expectedPath).exists())) {
        await Bun.write(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
      }
      expect(actual).toEqual(await readJson(expectedPath));
    });
  }
});

describe("determinism", () => {
  for (const name of cases) {
    test(`${name}: same input gives the same view, whatever the stored item order`, async () => {
      const input = await loadFixture(name);
      const first = JSON.stringify(deriveSubjectView(input));
      expect(JSON.stringify(deriveSubjectView(input))).toBe(first);
      const reversed = { ...input, items: input.items.toReversed(), stickies: input.stickies.toReversed() };
      expect(JSON.stringify(deriveSubjectView(reversed))).toBe(first);
    });
  }

  test("output depends on the passed-in now, not the clock", async () => {
    const input = await loadFixture("redux-toolkit-5641");
    const snoozed: DeriveInput = {
      ...input,
      state: { ...input.state, snoozeUntil: "2026-11-25T00:00:00Z" },
    };
    expect(deriveSubjectView(snoozed).section).toBe("snoozed");
    expect(deriveSubjectView({ ...snoozed, now: new Date("2026-11-26T00:00:00Z") }).section).not.toBe(
      "snoozed",
    );
  });
});
