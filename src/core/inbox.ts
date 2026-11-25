// Response shapes for the inbox API and the pure functions that build them. The server
// handlers and the web client both import these types.
import type { InboxRow, Section, SubjectView } from "./pipeline/types.ts";
import type { SubjectKey, ThreadRecord } from "./types.ts";
import type { WorkstreamState, WsPriority } from "./workstream-state.ts";
import { type StackContext, stackContext, type Workstream } from "./workstreams.ts";

/** A workstream's newest stored summary. */
export interface WorkstreamSummaryInput {
  /** Suggested name. */
  name: string | null;
  text: string;
  status: string | null;
  generatedAt: string;
  inputHash: string;
}

export interface GroupSummary {
  text: string;
  status: string | null;
  generatedAt: string;
  /** Sent back with the `seen` op so the server can record which summary was read. */
  hash: string;
  /** The summary changed since the group was last opened. */
  changed: boolean;
}

/** A workstream's row in the inbox. Its listed members are not also listed as their own rows. */
export interface InboxGroup {
  kind: "workstream";
  id: string;
  repo: string;
  /** Manual rename, else the generated name, else the title prefix. */
  name: string;
  summary: GroupSummary | null;
  priority: WsPriority;
  /** Not opened yet and no priority set. */
  isNew: boolean;
  /** Best member section; Updates at most for low priority; Hidden when muted; Snoozed while snoozed. */
  section: Section;
  /** Newest listed member's `sortAt`. */
  sortAt: string;
  /** Members in Waiting or Updates, in stack order. */
  members: InboxRow[];
  /** Every member key in stack order, so a row that returns from Hidden finds its group. */
  memberKeys: SubjectKey[];
  /** Members not listed here: done, hidden, snoozed on their own, or with no notification. */
  moreCount: number;
  /** Members their authors closed unmerged. */
  closedByAuthor: number;
  closed: boolean;
  snoozed: boolean;
  snoozeUntil: string | null;
}

export type InboxEntry = InboxRow | InboxGroup;

export function isGroup(entry: InboxEntry): entry is InboxGroup {
  return entry.kind === "workstream";
}

/** The list key of an entry: the subject key, or `workstream:<id>` for a group. */
export function entryKey(entry: InboxEntry): string {
  return isGroup(entry) ? groupKey(entry.id) : entry.key;
}

export function groupKey(id: string): string {
  return `workstream:${id}`;
}

/** What the inbox builder needs about one workstream. */
export interface WorkstreamInput {
  workstream: Workstream;
  state: WorkstreamState | null;
  summary: WorkstreamSummaryInput | null;
  /**
   * Whether the group's snooze still holds, once its wake conditions were checked against the
   * members' events. Without it, any snooze in `state` counts.
   */
  snoozed?: boolean;
}

/** Where a subject sits in its workstream, for the preview's stack box. */
export interface SubjectWorkstream {
  id: string;
  name: string;
  stack: StackContext;
  summary: GroupSummary | null;
  /** Titles of the parent and children, when they have rows. */
  titles: Record<SubjectKey, string>;
}

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
  /** Sorted by section order, then new workstreams, then `sortAt` newest first. */
  rows: InboxEntry[];
  sidebar: { sections: SectionCounts; repos: RepoCounts[] };
  /**
   * Per-repo summaries of hidden activity, e.g. "backend: 38 pushed, 12 merged", followed by
   * one "backend: 3 closed by author" line per repo for PRs their authors closed unmerged.
   */
  countLines: string[];
  generatedAt: string;
}

export interface SubjectDetail extends SubjectView {
  /** Notification reason of the newest thread, e.g. "review_requested". */
  reason: string | null;
  /** GitHub page for the subject, or the notification's URL when there is no PR or issue. */
  githubUrl: string | null;
  workstream: SubjectWorkstream | null;
}

const SECTION_ORDER: Record<Section, number> = { waiting: 0, updates: 1, snoozed: 2, hidden: 3 };

const isNewGroup = (e: InboxEntry) => (isGroup(e) && e.isNew ? 0 : 1);

/** Inbox order: section, then new workstreams, then `sortAt` newest first, then key. */
export function compareRows(a: InboxEntry, b: InboxEntry): number {
  const ka = entryKey(a);
  const kb = entryKey(b);
  return (
    SECTION_ORDER[a.section] - SECTION_ORDER[b.section] ||
    isNewGroup(a) - isNewGroup(b) ||
    (a.sortAt < b.sortAt ? 1 : a.sortAt > b.sortAt ? -1 : 0) ||
    (ka < kb ? -1 : ka > kb ? 1 : 0)
  );
}

/** Entries per section. A group counts once. */
export function sectionCounts(rows: readonly InboxEntry[]): SectionCounts {
  const sections: SectionCounts = { waiting: 0, updates: 0, snoozed: 0, hidden: 0 };
  for (const row of rows) sections[row.section] += 1;
  return sections;
}

/** Waiting and Updates entries per repo, busiest repo first. Repos with neither are left out. */
export function repoCounts(rows: readonly InboxEntry[]): RepoCounts[] {
  const repos = new Map<string, RepoCounts>();
  for (const row of rows) {
    if (row.section !== "waiting" && row.section !== "updates") continue;
    const counts = repos.get(row.repo) ?? { repo: row.repo, waiting: 0, updates: 0 };
    counts[row.section] += 1;
    repos.set(row.repo, counts);
  }
  return [...repos.values()].sort(
    (a, b) => b.waiting + b.updates - (a.waiting + a.updates) || (a.repo < b.repo ? -1 : 1),
  );
}

/** A review request or mention keeps a row in its section through a mute, its own or its workstream's. */
export function keepsSection(row: InboxRow): boolean {
  return row.reasons.includes("reviewRequested") || row.reasons.includes("mentioned");
}

function absorbs(group: InboxGroup, row: InboxRow): boolean {
  if (row.section !== "waiting" && row.section !== "updates") return false;
  return group.priority !== "muted" || !keepsSection(row);
}

export function groupSection(group: Pick<InboxGroup, "priority" | "snoozed" | "isNew" | "members">): Section {
  if (group.priority === "muted") return "hidden";
  if (group.snoozed) return "snoozed";
  if (group.members.length === 0) return group.isNew ? "updates" : "hidden";
  if (group.priority === "low") return "updates";
  return group.members.some((m) => m.section === "waiting") ? "waiting" : "updates";
}

/**
 * Puts each row that belongs to a listed group into it (or back out as its own row when it
 * left Waiting and Updates), recomputes each group's members, section, `sortAt` and
 * `moreCount`, drops groups left with no members unless they are new, and sorts.
 * A row listed twice keeps its last copy.
 */
export function reflowEntries(entries: readonly InboxEntry[]): InboxEntry[] {
  const groups: InboxGroup[] = [];
  const loose = new Map<SubjectKey, InboxRow>();
  const addLoose = (row: InboxRow) => {
    loose.delete(row.key);
    loose.set(row.key, row);
  };
  for (const entry of entries) {
    if (isGroup(entry)) {
      groups.push({ ...entry, members: [] });
      entry.members.forEach(addLoose);
    } else {
      addLoose(entry);
    }
  }
  const owner = new Map<SubjectKey, InboxGroup>();
  for (const group of groups) for (const key of group.memberKeys) if (!owner.has(key)) owner.set(key, group);

  const out: InboxEntry[] = [];
  for (const row of loose.values()) {
    const group = owner.get(row.key);
    if (group && absorbs(group, row)) group.members.push(row);
    else out.push(row);
  }
  for (const group of groups) {
    if (group.members.length === 0 && !group.isNew) continue;
    const order = new Map(group.memberKeys.map((key, i) => [key, i]));
    group.members.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    group.moreCount = group.memberKeys.length - group.members.length;
    if (group.members.length > 0) {
      group.sortAt = group.members.reduce((max, m) => (m.sortAt > max ? m.sortAt : max), "");
    }
    group.section = groupSection(group);
    out.push(group);
  }
  return out.sort(compareRows);
}

/**
 * Reflows changed entries into a payload: drops Hidden entries unless `includeHidden`, and
 * recomputes the sidebar. Without Hidden entries in the list, the Hidden count grows by the
 * entries that moved there and shrinks by `returnedFromHidden`, the entries that came back.
 */
export function settleInbox(
  previous: InboxPayload,
  entries: readonly InboxEntry[],
  includeHidden: boolean,
  returnedFromHidden = 0,
): InboxPayload {
  const all = reflowEntries(entries);
  const rows = includeHidden ? all : all.filter((e) => e.section !== "hidden");
  const sections = sectionCounts(all);
  if (!includeHidden) {
    sections.hidden = Math.max(0, previous.sidebar.sections.hidden + sections.hidden - returnedFromHidden);
  }
  return { ...previous, rows, sidebar: { sections, repos: repoCounts(rows) } };
}

function groupSummary(input: WorkstreamInput): GroupSummary | null {
  const { summary, state } = input;
  if (!summary) return null;
  return {
    text: summary.text,
    status: summary.status,
    generatedAt: summary.generatedAt,
    hash: summary.inputHash,
    changed: state?.seenSummaryHash != null && state.seenSummaryHash !== summary.inputHash,
  };
}

/** A manual rename wins over the summary's suggested name, which wins over the detected name. */
function groupName(input: WorkstreamInput): string {
  const { workstream: ws, summary } = input;
  if (ws.nameSource === "manual") return ws.name;
  return summary?.name || ws.name;
}

/** An empty group for a workstream; `reflowEntries` fills in its members. */
export function buildGroup(input: WorkstreamInput, allRows: readonly InboxRow[]): InboxGroup {
  const { workstream: ws, state } = input;
  const priority = state?.priority ?? "normal";
  const memberSet = new Set(ws.members);
  const snoozed =
    input.snoozed ??
    (state !== null && (state.snoozeUntil !== null || state.snoozeUntilHumanEvent || state.snoozeUntilReady));
  return {
    kind: "workstream",
    id: ws.id,
    repo: ws.repo,
    name: groupName(input),
    summary: groupSummary(input),
    priority,
    isNew: !ws.closed && (state?.seenAt ?? null) === null,
    section: "updates",
    sortAt: "",
    members: [],
    memberKeys: [...ws.members],
    moreCount: ws.members.length,
    closedByAuthor: allRows.filter(
      (r) => memberSet.has(r.key) && r.section === "hidden" && r.reasons.includes("closedByAuthor"),
    ).length,
    closed: ws.closed,
    snoozed,
    snoozeUntil: state?.snoozeUntil ?? null,
  };
}

/** The preview's stack box for `key`, or null when it is not in a stack of two or more. */
export function subjectWorkstream(
  input: WorkstreamInput,
  key: SubjectKey,
  titleOf: (key: SubjectKey) => string | null,
): SubjectWorkstream | null {
  const stack = stackContext(input.workstream, key);
  if (!stack || stack.size < 2) return null;
  const titles: Record<SubjectKey, string> = {};
  for (const k of [stack.parent, ...stack.children]) {
    const title = k === null ? null : titleOf(k);
    if (k !== null && title !== null) titles[k] = title;
  }
  return { id: input.workstream.id, name: groupName(input), stack, summary: groupSummary(input), titles };
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

function capped(lines: string[]): string[] {
  const kept = lines.slice(0, MAX_COUNT_LINES);
  const rest = lines.length - kept.length;
  if (rest > 0) kept.push(`and ${rest} more ${rest === 1 ? "repo" : "repos"}`);
  return kept;
}

/**
 * Builds the inbox response from every stored row. Hidden rows feed the section count
 * and the count lines, and are listed only when `includeHidden` is set.
 */
export function buildInboxPayload(
  allRows: readonly InboxRow[],
  opts: { includeHidden: boolean; now: Date; workstreams?: readonly WorkstreamInput[] },
): InboxPayload {
  const groups = (opts.workstreams ?? [])
    .filter((input) => input.workstream.members.length >= 2)
    .map((input) => buildGroup(input, allRows));
  const all = reflowEntries([...allRows, ...groups]);
  const listed = new Set(all.filter(isGroup).flatMap((g) => g.memberKeys));
  const hidden = new Map<string, { pushes: number; merged: number; closed: number }>();
  const closedByAuthor = new Map<string, number>();
  for (const row of allRows) {
    if (row.section !== "hidden") continue;
    if (row.reasons.includes("closedByAuthor")) {
      if (listed.has(row.key)) continue;
      closedByAuthor.set(row.repo, (closedByAuthor.get(row.repo) ?? 0) + 1);
      continue;
    }
    const stats = hidden.get(row.repo) ?? { pushes: 0, merged: 0, closed: 0 };
    stats.pushes += row.hiddenStats.pushes;
    stats.merged += row.hiddenStats.merged;
    stats.closed += row.hiddenStats.closed;
    hidden.set(row.repo, stats);
  }
  const total = (s: { pushes: number; merged: number; closed: number }) => s.pushes + s.merged + s.closed;
  const allLines = [...hidden]
    .sort(([ra, a], [rb, b]) => total(b) - total(a) || (ra < rb ? -1 : 1))
    .map(([repo, stats]) => countLine(repo, stats))
    .filter((line) => line !== null);
  const closedLines = [...closedByAuthor]
    .sort(([ra, a], [rb, b]) => b - a || (ra < rb ? -1 : 1))
    .map(([repo, count]) => `${shortName(repo)}: ${count} closed by author`);
  const countLines = [...capped(allLines), ...capped(closedLines)];
  const rows = all.filter((row) => opts.includeHidden || row.section !== "hidden");
  return {
    rows,
    sidebar: { sections: sectionCounts(all), repos: repoCounts(all) },
    countLines,
    generatedAt: opts.now.toISOString(),
  };
}

/** Adds the newest thread's reason, the GitHub URL and the stack box to a stored view. `threads` are newest first. */
export function buildSubjectDetail(
  view: SubjectView,
  threads: readonly ThreadRecord[],
  workstream: SubjectWorkstream | null = null,
): SubjectDetail {
  const newest = threads[0];
  return {
    ...view,
    reason: newest?.reason ?? null,
    githubUrl: view.header.url ?? notificationUrl(newest) ?? null,
    workstream,
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
