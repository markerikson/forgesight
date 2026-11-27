// Response shapes for the inbox API and the pure functions that build them. The server
// handlers and the web client both import these types.
import type { InboxRow, Section, SubjectView } from "./pipeline/types.ts";
import type { Login, SubjectKey, SubjectState, ThreadRecord } from "./types.ts";
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
  /**
   * Found by the repo's first workstream build, or of unknown age. Every group is unseen after
   * that build, so these get no "new workstream" badge; see `isNewWorkstream`.
   */
  firstBuild: boolean;
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
  /** The members not listed here that the inbox knows about, in stack order. */
  unlisted: UnlistedMember[];
  /** Members their authors closed unmerged. */
  closedByAuthor: number;
  closed: boolean;
  snoozed: boolean;
  snoozeUntil: string | null;
  /** The first member's description when it has no inbox row; otherwise the preview loads it. */
  rootBody: RootBody | null;
  /**
   * A repo's new issues, grouped by the inbox when two or more are listed. Not a stored
   * workstream, so it has no rename, priority, snooze, merge or seen state.
   */
  newIssues?: true;
}

/** True for a group of a repo's new issues rather than a stored workstream. */
export function isNewIssuesGroup(group: InboxGroup): boolean {
  return group.newIssues === true;
}

/** A stored PR description: GitHub's plain-text rendering, cut to a fixed length. */
export interface RootBody {
  text: string;
  /** The stored text was cut short; the full description is on GitHub. */
  clipped: boolean;
}

/** Why a member is not listed in its group: its row is Hidden or Snoozed, or it has no notification. */
export type UnlistedReason = "hidden" | "snoozed" | "noThread";

/** Enough about an unlisted member to show it in its stack. */
export interface UnlistedMember {
  key: SubjectKey;
  number: number | null;
  title: string;
  url: string | null;
  state: SubjectState | null;
  draft: boolean;
  author: Login | null;
  /** Last activity: the row's `sortAt`, else the PR's `updatedAt` when listed or fetched. */
  updatedAt: string | null;
  why: UnlistedReason;
}

/** A member with no inbox row, from the open-pulls listing. */
export type ListedPull = Omit<UnlistedMember, "key" | "why">;

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
  /** Members with no inbox row, so the group can still show them. */
  pulls?: Record<SubjectKey, ListedPull>;
  /** The first member's stored description, when that member has no inbox row. */
  rootBody?: RootBody | null;
  /** When this workstream was first stored. */
  firstSeenAt?: string;
  /** When the repo's first workstream was stored: its first workstream build. */
  repoFirstSeenAt?: string;
}

/** Where a subject sits in its workstream, for the preview's stack box. */
export interface SubjectWorkstream {
  id: string;
  name: string;
  stack: StackContext;
  /**
   * The subject sits on a branch stack: it has a parent or children in the group. False for
   * members grouped by config, title or a manual merge, which have no base-branch relation.
   */
  stacked: boolean;
  summary: GroupSummary | null;
  /** Titles of the parent and children, when known. */
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
   * Hidden PRs their authors closed unmerged, per repo, busiest first. Members of a listed
   * workstream are left out; the group shows its own count.
   */
  closedByAuthor: ClosedByAuthorCount[];
  generatedAt: string;
}

export interface ClosedByAuthorCount {
  repo: string;
  count: number;
}

export interface SubjectDetail extends SubjectView {
  /** Notification reason of the newest thread, e.g. "review_requested". */
  reason: string | null;
  /** GitHub page for the subject, or the notification's URL when there is no PR or issue. */
  githubUrl: string | null;
  workstream: SubjectWorkstream | null;
  /** The worker can fetch this subject from GitHub (a PR, or an issue when issues are enriched). */
  refreshable: boolean;
  /** Queued for a fetch; the view updates when the worker finishes it. */
  fetching: boolean;
}

export type SubjectFetchState = Pick<SubjectDetail, "refreshable" | "fetching">;

const SECTION_ORDER: Record<Section, number> = { waiting: 0, updates: 1, snoozed: 2, hidden: 3 };

/** Unseen, and found after the repo's first workstream build: worth a "new workstream" badge. */
export function isNewWorkstream(group: Pick<InboxGroup, "isNew" | "firstBuild">): boolean {
  return group.isNew && !group.firstBuild;
}

/** A group's members by state, listed and unlisted, and its newest member activity. */
export interface GroupTotals {
  /** Open and not draft. */
  open: number;
  draft: number;
  merged: number;
  closed: number;
  lastActivityAt: string | null;
}

/** Totals over the members the group knows about; members with an unknown state are not counted. */
export function groupTotals(group: Pick<InboxGroup, "members" | "unlisted">): GroupTotals {
  const totals: GroupTotals = { open: 0, draft: 0, merged: 0, closed: 0, lastActivityAt: null };
  const members = [
    ...group.members.map((m) => ({ state: m.merged ? "MERGED" : m.state, draft: m.draft, at: m.sortAt })),
    ...group.unlisted.map((u) => ({ state: u.state, draft: u.draft, at: u.updatedAt })),
  ];
  for (const { state, draft, at } of members) {
    if (state === "MERGED") totals.merged++;
    else if (state === "CLOSED") totals.closed++;
    else if (state === "OPEN") {
      if (draft) totals.draft++;
      else totals.open++;
    }
    if (at && (totals.lastActivityAt === null || at > totals.lastActivityAt)) totals.lastActivityAt = at;
  }
  return totals;
}

/** The group's main authors: the `limit` with the most members, then how many other authors it has. */
export function groupAuthors(
  group: Pick<InboxGroup, "members" | "unlisted">,
  limit = 2,
): { top: string[]; others: number } {
  const counts = new Map<string, number>();
  for (const { author } of [...group.members, ...group.unlisted]) {
    if (author) counts.set(author, (counts.get(author) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, na], [b, nb]) => nb - na || (a < b ? -1 : a > b ? 1 : 0));
  return { top: ranked.slice(0, limit).map(([author]) => author), others: Math.max(0, ranked.length - limit) };
}

const isNewGroup = (e: InboxEntry) => (isGroup(e) && isNewWorkstream(e) ? 0 : 1);

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

/**
 * A review request or mention keeps a row in its section through a mute, its own or its
 * workstream's, and keeps it out of a low or muted workstream's group.
 */
export function keepsSection(row: InboxRow): boolean {
  return row.reasons.includes("reviewRequested") || row.reasons.includes("mentioned");
}

/**
 * A row marked Done that has seen no activity since stays out of every list, Hidden included,
 * and out of its counts. Activity newer than the Done moves `sortAt` past it and brings the row
 * back; a row Done lifted out of Hidden (kept unread, a request) is listed as usual.
 */
export function isDoneQuiet(row: Pick<InboxRow, "section" | "sortAt">, doneAt: string | null): boolean {
  if (doneAt === null || row.section !== "hidden") return false;
  return Date.parse(row.sortAt) <= Date.parse(doneAt);
}

function absorbs(group: InboxGroup, row: InboxRow): boolean {
  if (row.section !== "waiting" && row.section !== "updates") return false;
  if (isNewIssuesGroup(group)) return isListedNewIssue(row);
  return group.priority === "normal" || !keepsSection(row);
}

/**
 * A group listed in Hidden lists its Hidden members too, instead of leaving them as their own
 * rows: a muted group, and a group with nothing in Waiting or Updates. A new group stays in
 * Updates to be seen, and a group listed elsewhere shows its Hidden members as unlisted.
 */
function gathersHidden(group: InboxGroup): boolean {
  if (isNewIssuesGroup(group)) return false;
  if (group.priority === "muted") return true;
  return group.members.length === 0 && !group.isNew;
}

export function groupSection(group: Pick<InboxGroup, "priority" | "snoozed" | "isNew" | "members">): Section {
  if (group.priority === "muted") return "hidden";
  if (group.members.length > 0 && group.members.every((m) => m.section === "hidden")) return "hidden";
  if (group.snoozed) return "snoozed";
  if (group.members.length === 0) return group.isNew ? "updates" : "hidden";
  if (group.priority === "low") return "updates";
  return group.members.some((m) => m.section === "waiting") ? "waiting" : "updates";
}

/**
 * Puts each row that belongs to a listed group into it (or back out as its own row when it
 * left Waiting and Updates, unless the group gathers its Hidden members), recomputes each group's members, section, `sortAt` and
 * `moreCount`, drops groups left with no members unless they are new or muted (muted ones stay
 * in Hidden) and still have an unlisted member to show, and sorts.
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
  const hidden: InboxRow[] = [];
  for (const row of loose.values()) {
    const group = owner.get(row.key);
    if (group && absorbs(group, row)) group.members.push(row);
    else if (group && row.section === "hidden") hidden.push(row);
    else out.push(row);
  }
  const gathering = new Set(groups.filter(gathersHidden));
  for (const row of hidden) {
    const group = owner.get(row.key);
    if (group && gathering.has(group)) group.members.push(row);
    else out.push(row);
  }
  for (const group of groups) {
    if (isNewIssuesGroup(group) && group.members.length < 2) {
      out.push(...group.members);
      continue;
    }
    if (group.members.length === 0 && !group.isNew && group.priority !== "muted") continue;
    const newIssues = isNewIssuesGroup(group);
    group.unlisted = newIssues ? [] : unlistedMembers(group, loose);
    if (group.members.length === 0 && group.unlisted.length === 0) continue;
    const order = new Map(group.memberKeys.map((key, i) => [key, i]));
    group.members.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    group.moreCount = newIssues ? 0 : group.memberKeys.length - group.members.length;
    if (group.members.length > 0) {
      group.sortAt = group.members.reduce((max, m) => (m.sortAt > max ? m.sortAt : max), "");
    }
    group.section = groupSection(group);
    out.push(group);
  }
  return out.sort(compareRows);
}

/**
 * The group's members that are neither listed in it nor listed as their own row, from their
 * Hidden or Snoozed rows when present, else from what the group already knew about them.
 */
function unlistedMembers(group: InboxGroup, rows: ReadonlyMap<SubjectKey, InboxRow>): UnlistedMember[] {
  const listed = new Set(group.members.map((m) => m.key));
  const known = new Map(group.unlisted.map((u) => [u.key, u]));
  const out: UnlistedMember[] = [];
  for (const key of group.memberKeys) {
    if (listed.has(key)) continue;
    const row = rows.get(key);
    if (row) {
      if (row.section !== "hidden" && row.section !== "snoozed") continue;
      const { number, title, url, state, draft, author } = row;
      out.push({ key, number, title, url, state, draft, author, updatedAt: row.sortAt, why: row.section });
      continue;
    }
    const prior = known.get(key);
    if (prior) out.push(prior);
  }
  return out;
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
  return workstreamDisplayName(input.workstream, input.summary?.name);
}

export function workstreamDisplayName(
  ws: Pick<WorkstreamInput["workstream"], "name" | "nameSource">,
  summaryName: string | null | undefined,
): string {
  if (ws.nameSource === "manual") return ws.name;
  return summaryName || ws.name;
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
    firstBuild:
      input.firstSeenAt === undefined ||
      input.repoFirstSeenAt === undefined ||
      input.firstSeenAt <= input.repoFirstSeenAt,
    section: "updates",
    sortAt: "",
    members: [],
    memberKeys: [...ws.members],
    moreCount: ws.members.length,
    unlisted: ws.members.flatMap((key) => {
      const pull = input.pulls?.[key];
      return pull ? [{ key, ...pull, why: "noThread" as const }] : [];
    }),
    closedByAuthor: allRows.filter(
      (r) => memberSet.has(r.key) && r.section === "hidden" && r.reasons.includes("closedByAuthor"),
    ).length,
    closed: ws.closed,
    snoozed,
    snoozeUntil: state?.snoozeUntil ?? null,
    rootBody: input.rootBody ?? null,
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
  const stacked = stack.parent !== null || stack.children.length > 0;
  return { id: input.workstream.id, name: groupName(input), stack, stacked, summary: groupSummary(input), titles };
}

function shortName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

const MAX_CLOSED_LINES = 5;

export interface HiddenActivity {
  /** Hidden rows with activity after `since`. */
  items: number;
  pushes: number;
  /** Force-pushes checked as rebase-only or unchanged. */
  rebases: number;
  merged: number;
  closed: number;
}

/**
 * Sums the hidden activity of hidden rows whose newest activity (`sortAt`) is after `since`,
 * in one repo or all of them. Rows their authors closed unmerged are left to
 * `closedByAuthorLines`. Each row's counts cover its activity since it was last dismissed,
 * which can reach back before `since`.
 */
export function hiddenActivitySince(
  entries: readonly InboxEntry[],
  since: string,
  repo: string | null,
): HiddenActivity {
  const out: HiddenActivity = { items: 0, pushes: 0, rebases: 0, merged: 0, closed: 0 };
  const seen = new Set<SubjectKey>();
  const sinceMs = Date.parse(since);
  for (const row of entries.flatMap((e) => (isGroup(e) ? e.members : [e]))) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    if (row.section !== "hidden" || row.reasons.includes("closedByAuthor")) continue;
    if (repo !== null && row.repo !== repo) continue;
    if (!(Date.parse(row.sortAt) > sinceMs)) continue;
    out.items += 1;
    out.pushes += row.hiddenStats.pushes;
    out.rebases += row.hiddenStats.rebases ?? 0;
    out.merged += row.hiddenStats.merged;
    out.closed += row.hiddenStats.closed;
  }
  return out;
}

/** e.g. "Since you last looked: 12 pushes, 40 rebases, 3 merged across 5 hidden items". */
export function hiddenActivityLine(activity: HiddenActivity): string {
  if (activity.items === 0) return "Nothing new in Hidden since you last looked";
  const parts = [
    activity.pushes > 0 ? `${activity.pushes} ${activity.pushes === 1 ? "push" : "pushes"}` : null,
    activity.rebases > 0 ? `${activity.rebases} ${activity.rebases === 1 ? "rebase" : "rebases"}` : null,
    activity.merged > 0 ? `${activity.merged} merged` : null,
    activity.closed > 0 ? `${activity.closed} closed` : null,
  ].filter((p) => p !== null);
  const items = `${activity.items} hidden ${activity.items === 1 ? "item" : "items"}`;
  return parts.length > 0
    ? `Since you last looked: ${parts.join(", ")} across ${items}`
    : `Since you last looked: activity on ${items}`;
}

/** One "backend: 3 closed by author" line per repo, busiest first, capped with an "and N more repos" line. */
export function closedByAuthorLines(counts: readonly ClosedByAuthorCount[], repo: string | null): string[] {
  const lines = counts
    .filter((c) => repo === null || c.repo === repo)
    .map((c) => `${shortName(c.repo)}: ${c.count} closed by author`);
  const kept = lines.slice(0, MAX_CLOSED_LINES);
  const rest = lines.length - kept.length;
  if (rest > 0) kept.push(`and ${rest} more ${rest === 1 ? "repo" : "repos"}`);
  return kept;
}

function isListedNewIssue(row: InboxRow): boolean {
  return row.kind === "issue" && row.section === "updates" && row.reasons.includes("newIssue");
}

/** One empty group per repo with two or more new issues that no workstream lists. */
export function newIssuesGroups(allRows: readonly InboxRow[], workstreams: readonly InboxGroup[]): InboxGroup[] {
  const taken = new Set(workstreams.flatMap((g) => g.memberKeys));
  const byRepo = new Map<string, InboxRow[]>();
  for (const row of allRows) {
    if (!isListedNewIssue(row) || taken.has(row.key)) continue;
    byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
  }
  return [...byRepo]
    .filter(([, rows]) => rows.length >= 2)
    .map(([repo, rows]) => {
      const memberKeys = [...rows].sort((a, b) => (a.sortAt < b.sortAt ? 1 : -1)).map((r) => r.key);
      return {
        kind: "workstream",
        id: `new-issues:${repo}`,
        repo,
        name: "New issues",
        summary: null,
        priority: "normal",
        isNew: false,
        firstBuild: true,
        section: "updates",
        sortAt: "",
        members: [],
        memberKeys,
        moreCount: memberKeys.length,
        unlisted: [],
        closedByAuthor: 0,
        closed: false,
        snoozed: false,
        snoozeUntil: null,
        rootBody: null,
        newIssues: true,
      };
    });
}

/**
 * Builds the inbox response from every stored row. Hidden rows feed the section count
 * and the closed-by-author counts, and are listed only when `includeHidden` is set.
 */
export function buildInboxPayload(
  allRows: readonly InboxRow[],
  opts: { includeHidden: boolean; now: Date; workstreams?: readonly WorkstreamInput[] },
): InboxPayload {
  const groups = (opts.workstreams ?? [])
    .filter((input) => input.workstream.members.length >= 2)
    .map((input) => buildGroup(input, allRows));
  const all = reflowEntries([...allRows, ...groups, ...newIssuesGroups(allRows, groups)]);
  const listed = new Set(all.filter(isGroup).flatMap((g) => g.memberKeys));
  const closed = new Map<string, number>();
  for (const row of allRows) {
    if (row.section !== "hidden" || !row.reasons.includes("closedByAuthor") || listed.has(row.key)) continue;
    closed.set(row.repo, (closed.get(row.repo) ?? 0) + 1);
  }
  const closedByAuthor = [...closed]
    .sort(([ra, a], [rb, b]) => b - a || (ra < rb ? -1 : 1))
    .map(([repo, count]) => ({ repo, count }));
  const rows = all.filter((row) => opts.includeHidden || row.section !== "hidden");
  return {
    rows,
    sidebar: { sections: sectionCounts(all), repos: repoCounts(all) },
    closedByAuthor,
    generatedAt: opts.now.toISOString(),
  };
}

/** Adds the newest thread's reason, the GitHub URL and the stack box to a stored view. `threads` are newest first. */
export function buildSubjectDetail(
  view: SubjectView,
  threads: readonly ThreadRecord[],
  workstream: SubjectWorkstream | null = null,
  fetch: SubjectFetchState = { refreshable: false, fetching: false },
): SubjectDetail {
  const newest = threads[0];
  return {
    ...view,
    reason: newest?.reason ?? null,
    githubUrl: view.header.url ?? notificationUrl(newest) ?? null,
    workstream,
    ...fetch,
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
