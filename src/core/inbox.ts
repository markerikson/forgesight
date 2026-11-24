// Response shapes for the inbox API and the pure functions that build them. The server
// handlers and the web client both import these types.
import type { InboxRow, Section, SubjectView } from "./pipeline/types.ts";
import type { ThreadRecord } from "./types.ts";

export interface SectionCounts {
  waiting: number;
  updates: number;
  snoozed: number;
  hidden: number;
}

export interface RepoCounts {
  repo: string;
  waiting: number;
  updates: number;
}

export interface InboxPayload {
  /** Sorted by section order, then `sortAt` newest first. */
  rows: InboxRow[];
  sidebar: { sections: SectionCounts; repos: RepoCounts[] };
  /** Per-repo summaries of hidden activity, e.g. "backend: 38 pushed, 12 merged". */
  countLines: string[];
  generatedAt: string;
}

export interface SubjectDetail extends SubjectView {
  /** Notification reason of the newest thread, e.g. "review_requested". */
  reason: string | null;
  /** GitHub page for the subject, or the notification's URL when there is no PR or issue. */
  githubUrl: string | null;
}

const SECTION_ORDER: Record<Section, number> = { waiting: 0, updates: 1, snoozed: 2, hidden: 3 };

function compareRows(a: InboxRow, b: InboxRow): number {
  return (
    SECTION_ORDER[a.section] - SECTION_ORDER[b.section] ||
    (a.sortAt < b.sortAt ? 1 : a.sortAt > b.sortAt ? -1 : 0) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

function shortName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

const MAX_COUNT_LINES = 5;

function countLine(repo: string, stats: { pushes: number; merged: number; closed: number }): string | null {
  const parts = [
    stats.pushes > 0 ? `${stats.pushes} pushed` : null,
    stats.merged > 0 ? `${stats.merged} merged` : null,
    stats.closed > 0 ? `${stats.closed} closed` : null,
  ].filter((p) => p !== null);
  return parts.length > 0 ? `${shortName(repo)}: ${parts.join(", ")}` : null;
}

/**
 * Builds the inbox response from every stored row. Hidden rows feed the section count
 * and the count lines, and are listed only when `includeHidden` is set.
 */
export function buildInboxPayload(
  allRows: readonly InboxRow[],
  opts: { includeHidden: boolean; now: Date },
): InboxPayload {
  const sections: SectionCounts = { waiting: 0, updates: 0, snoozed: 0, hidden: 0 };
  const repos = new Map<string, RepoCounts>();
  const hidden = new Map<string, { pushes: number; merged: number; closed: number }>();
  for (const row of allRows) {
    sections[row.section] += 1;
    if (row.section === "waiting" || row.section === "updates") {
      const counts = repos.get(row.repo) ?? { repo: row.repo, waiting: 0, updates: 0 };
      counts[row.section] += 1;
      repos.set(row.repo, counts);
    } else if (row.section === "hidden") {
      const stats = hidden.get(row.repo) ?? { pushes: 0, merged: 0, closed: 0 };
      stats.pushes += row.hiddenStats.pushes;
      stats.merged += row.hiddenStats.merged;
      stats.closed += row.hiddenStats.closed;
      hidden.set(row.repo, stats);
    }
  }
  const total = (s: { pushes: number; merged: number; closed: number }) => s.pushes + s.merged + s.closed;
  const allLines = [...hidden]
    .sort(([ra, a], [rb, b]) => total(b) - total(a) || (ra < rb ? -1 : 1))
    .map(([repo, stats]) => countLine(repo, stats))
    .filter((line) => line !== null);
  const countLines = allLines.slice(0, MAX_COUNT_LINES);
  const rest = allLines.length - countLines.length;
  if (rest > 0) countLines.push(`and ${rest} more ${rest === 1 ? "repo" : "repos"}`);
  const rows = allRows.filter((row) => opts.includeHidden || row.section !== "hidden").toSorted(compareRows);
  return {
    rows,
    sidebar: {
      sections,
      repos: [...repos.values()].sort(
        (a, b) => b.waiting + b.updates - (a.waiting + a.updates) || (a.repo < b.repo ? -1 : 1),
      ),
    },
    countLines,
    generatedAt: opts.now.toISOString(),
  };
}

/** Adds the newest thread's reason and the GitHub URL to a stored view. `threads` are newest first. */
export function buildSubjectDetail(view: SubjectView, threads: readonly ThreadRecord[]): SubjectDetail {
  const newest = threads[0];
  return {
    ...view,
    reason: newest?.reason ?? null,
    githubUrl: view.header.url ?? notificationUrl(newest) ?? null,
  };
}

/** The HTML page for a non-PR/issue notification, from the thread's API `subject.url` when it maps to one. */
function notificationUrl(thread: ThreadRecord | undefined): string | null {
  const api = thread?.subjectUrl;
  if (!api) return null;
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(api);
  if (!match) return null;
  const [, repo, rest = ""] = match;
  if (/^discussions\/\d+$/.test(rest)) return `https://github.com/${repo}/${rest}`;
  if (rest.startsWith("releases/")) return `https://github.com/${repo}/releases`;
  if (rest.startsWith("commits/")) return `https://github.com/${repo}/commit/${rest.slice("commits/".length)}`;
  return `https://github.com/${repo}`;
}
