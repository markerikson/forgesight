import type { Database } from "bun:sqlite";
import type { Section } from "../core/pipeline/types.ts";
import type { SubjectKey } from "../core/types.ts";
import {
  DEFAULT_WORKSTREAM_STATE,
  type MemberFacts,
  type WorkstreamState,
  type WsPriority,
} from "../core/workstream-state.ts";
import {
  type StackContext,
  stackContext,
  type Workstream,
  type WsOverride,
  type WsSignal,
} from "../core/workstreams.ts";
import { bool, jsonList, toJson } from "./rows.ts";
import { appendChange } from "./views.ts";

interface WorkstreamRow {
  id: string;
  repo: string;
  name: string;
  name_source: string;
  manual_name: string | null;
  signals_json: string;
  author: string;
  prefix: string | null;
  closed: number;
  closed_at: string | null;
  archived: number;
  first_seen_at: string;
  updated_at: string;
}

interface MemberRow {
  workstream_id: string;
  subject_key: string;
  position: number;
  parent_key: string | null;
  listing_only: number;
}

interface OverrideRow {
  id: number;
  repo: string;
  kind: string;
  payload_json: string;
  created_at: string;
}

interface WorkstreamStateRow {
  workstream_id: string;
  priority: string;
  seen_at: string | null;
  seen_summary_hash: string | null;
  snooze_until: string | null;
  snooze_until_human_event: number;
  snooze_until_ready: number;
  snoozed_at: string | null;
  updated_at: string;
}

export interface StoredMember {
  key: SubjectKey;
  position: number;
  parent: SubjectKey | null;
  /** No `subjects` row: the member is only known from the open-PR listing. */
  listingOnly: boolean;
}

export interface StoredWorkstream {
  id: string;
  repo: string;
  /** `manualName ?? detectedName`. */
  name: string;
  detectedName: string;
  manualName: string | null;
  /** `"manual"` when `manualName` is set, else how the detected name was chosen. */
  nameSource: Workstream["nameSource"];
  members: StoredMember[];
  signals: WsSignal[];
  author: string;
  prefix: string | null;
  closed: boolean;
  closedAt: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

/** How long a closed workstream that left the listing is kept for reopened-stack matching. */
const ARCHIVE_MS = 14 * 86_400_000;

export interface StoredOverride {
  id: number;
  repo: string;
  override: WsOverride;
  createdAt: string;
}

function fromRows(row: WorkstreamRow, members: MemberRow[]): StoredWorkstream {
  return {
    id: row.id,
    repo: row.repo,
    name: row.manual_name ?? row.name,
    detectedName: row.name,
    manualName: row.manual_name,
    nameSource: row.manual_name === null ? (row.name_source as Workstream["nameSource"]) : "manual",
    members: members
      .toSorted((a, b) => a.position - b.position)
      .map((m) => ({
        key: m.subject_key,
        position: m.position,
        parent: m.parent_key,
        listingOnly: m.listing_only !== 0,
      })),
    signals: JSON.parse(row.signals_json) as WsSignal[],
    author: row.author,
    prefix: row.prefix,
    closed: row.closed !== 0,
    closedAt: row.closed_at,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

/** The stored workstream in the shape `buildWorkstreams` returns. */
export function toWorkstream(ws: StoredWorkstream): Workstream {
  return {
    id: ws.id,
    repo: ws.repo,
    name: ws.name,
    nameSource: ws.nameSource,
    members: ws.members.map((m) => m.key),
    edges: ws.members.flatMap((m) => (m.parent === null ? [] : [{ child: m.key, parent: m.parent }])),
    signals: ws.signals,
    author: ws.author,
    prefix: ws.prefix,
    closed: ws.closed,
    closedAt: ws.closedAt,
  };
}

function membersByWorkstream(db: Database, ids: string[]): Map<string, MemberRow[]> {
  const rows = db
    .query<MemberRow, [string]>(
      "SELECT * FROM workstream_members WHERE workstream_id IN (SELECT value FROM json_each(?))",
    )
    .all(jsonList(ids));
  const out = new Map<string, MemberRow[]>();
  for (const r of rows) out.set(r.workstream_id, [...(out.get(r.workstream_id) ?? []), r]);
  return out;
}

function withMembers(db: Database, rows: WorkstreamRow[]): StoredWorkstream[] {
  const members = membersByWorkstream(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => fromRows(r, members.get(r.id) ?? []));
}

/** Current workstreams of one repo, or of every repo, ordered by id. */
export function listWorkstreams(db: Database, repo?: string): StoredWorkstream[] {
  const rows =
    repo === undefined
      ? db.query<WorkstreamRow, []>("SELECT * FROM workstreams WHERE archived = 0 ORDER BY id").all()
      : db
          .query<WorkstreamRow, [string]>(
            "SELECT * FROM workstreams WHERE repo = ? AND archived = 0 ORDER BY id",
          )
          .all(repo);
  return withMembers(db, rows);
}

/** Earliest `first_seen_at` per repo, archived workstreams included: when grouping first ran there. */
export function firstWorkstreamBuilds(db: Database): Map<string, string> {
  const rows = db
    .query<{ repo: string; first: string }, []>(
      "SELECT repo, MIN(first_seen_at) AS first FROM workstreams GROUP BY repo",
    )
    .all();
  return new Map(rows.map((r) => [r.repo, r.first]));
}

/**
 * The `previous` input for `buildWorkstreams`: current workstreams of `repo` plus closed ones
 * that left the listing in the last 14 days (stored without members).
 */
export function previousWorkstreams(db: Database, repo: string): Workstream[] {
  const rows = db
    .query<WorkstreamRow, [string]>("SELECT * FROM workstreams WHERE repo = ? ORDER BY id")
    .all(repo);
  return withMembers(db, rows).map(toWorkstream);
}

/** A current (not archived) workstream. */
export function getWorkstream(db: Database, id: string): StoredWorkstream | undefined {
  const row = db
    .query<WorkstreamRow, [string]>("SELECT * FROM workstreams WHERE id = ? AND archived = 0")
    .get(id);
  return row ? withMembers(db, [row])[0] : undefined;
}

/** Workstream id for each of `keys` that is a member of one. */
export function workstreamIdsFor(db: Database, keys: string[]): Map<SubjectKey, string> {
  const rows = db
    .query<{ subject_key: string; workstream_id: string }, [string]>(
      `SELECT subject_key, workstream_id FROM workstream_members
       WHERE subject_key IN (SELECT value FROM json_each(?))
       ORDER BY workstream_id`,
    )
    .all(jsonList(keys));
  const out = new Map<SubjectKey, string>();
  for (const r of rows) if (!out.has(r.subject_key)) out.set(r.subject_key, r.workstream_id);
  return out;
}

export function workstreamForSubject(db: Database, key: string): StoredWorkstream | undefined {
  const id = workstreamIdsFor(db, [key]).get(key);
  return id === undefined ? undefined : getWorkstream(db, id);
}

/** Stack context for each of `keys` that is a member of a workstream. */
export function stackContextsFor(db: Database, keys: string[]): Map<SubjectKey, StackContext> {
  const ids = workstreamIdsFor(db, keys);
  const rows = db
    .query<WorkstreamRow, [string]>("SELECT * FROM workstreams WHERE id IN (SELECT value FROM json_each(?))")
    .all(jsonList([...new Set(ids.values())]));
  const byId = new Map(withMembers(db, rows).map((w) => [w.id, toWorkstream(w)]));
  const out = new Map<SubjectKey, StackContext>();
  for (const [key, id] of ids) {
    const ws = byId.get(id);
    const ctx = ws ? stackContext(ws, key) : null;
    if (ctx) out.set(key, ctx);
  }
  return out;
}

export interface WriteWorkstreamsResult {
  /** Subjects whose workstream, position or parent changed (a `stack` change was appended). */
  changedKeys: SubjectKey[];
  /** Workstreams added, changed or removed (a `workstream` change was appended). */
  changedIds: string[];
}

type MemberShape = Pick<StoredMember, "key" | "position" | "parent" | "listingOnly">;

/** Per-member signature covering everything `stackContext` reports (parent, children, position, size). */
function memberSigs(workstreamId: string, members: readonly MemberShape[]): Map<SubjectKey, string> {
  const children = new Map<SubjectKey, SubjectKey[]>();
  for (const m of members) {
    if (m.parent !== null) children.set(m.parent, [...(children.get(m.parent) ?? []), m.key]);
  }
  return new Map(
    members.map((m) => [
      m.key,
      [
        workstreamId,
        m.position,
        members.length,
        m.parent ?? "",
        (children.get(m.key) ?? []).toSorted().join(","),
        m.listingOnly ? 1 : 0,
      ].join("|"),
    ]),
  );
}

/**
 * Replaces the stored workstreams of `repo` with `workstreams`. Existing ids keep
 * `first_seen_at` and `manual_name`. Ids no longer present are archived for 14 days when
 * they closed recently (for reopened-stack matching) or carry a manual name (so undoing a
 * merge brings the name back); others are deleted. `workstream_state` is always kept, so a
 * group that comes back under the same id keeps its priority and snooze. Appends a `stack` change for each subject whose membership changed and a
 * `workstream` change for each workstream that changed.
 */
export function writeWorkstreams(
  db: Database,
  repo: string,
  workstreams: Workstream[],
  listingOnly: ReadonlySet<SubjectKey>,
  now: string,
): WriteWorkstreamsResult {
  return db.transaction(() => {
    const before = listWorkstreams(db, repo);
    const archivedFirstSeen = new Map(
      db
        .query<{ id: string; first_seen_at: string }, [string]>(
          "SELECT id, first_seen_at FROM workstreams WHERE repo = ? AND archived = 1",
        )
        .all(repo)
        .map((r) => [r.id, r.first_seen_at]),
    );
    const beforeById = new Map(before.map((w) => [w.id, w]));
    const oldSig = new Map<SubjectKey, string>();
    for (const w of before) {
      for (const [key, sig] of memberSigs(w.id, w.members)) oldSig.set(key, sig);
    }

    const newSig = new Map<SubjectKey, string>();
    const changedIds = new Set<string>();
    const upsertWs = db.query(
      `INSERT INTO workstreams (id, repo, name, name_source, signals_json, author, prefix, closed,
         closed_at, archived, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         repo = excluded.repo, name = excluded.name, name_source = excluded.name_source,
         signals_json = excluded.signals_json, author = excluded.author, prefix = excluded.prefix,
         closed = excluded.closed, closed_at = excluded.closed_at, archived = 0,
         updated_at = excluded.updated_at`,
    );
    const insertMember = db.query(
      `INSERT INTO workstream_members (workstream_id, subject_key, position, parent_key, listing_only)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const deleteMembers = db.query("DELETE FROM workstream_members WHERE workstream_id = ?");

    for (const ws of workstreams) {
      const members = ws.members.map((key, position) => ({
        key,
        position,
        parent: ws.edges.find((e) => e.child === key)?.parent ?? null,
        listingOnly: listingOnly.has(key),
      }));
      for (const [key, sig] of memberSigs(ws.id, members)) newSig.set(key, sig);

      const prev = beforeById.get(ws.id);
      const membersOf = (list: readonly MemberShape[]) => toJson([...memberSigs(ws.id, list)]);
      const same =
        prev !== undefined &&
        prev.detectedName === ws.name &&
        prev.author === ws.author &&
        prev.prefix === ws.prefix &&
        prev.closed === ws.closed &&
        prev.closedAt === ws.closedAt &&
        (prev.manualName !== null || prev.nameSource === ws.nameSource) &&
        toJson(prev.signals) === toJson(ws.signals) &&
        membersOf(prev.members) === membersOf(members);
      if (same) continue;

      changedIds.add(ws.id);
      upsertWs.run(
        ws.id,
        ws.repo,
        ws.name,
        ws.nameSource,
        toJson(ws.signals),
        ws.author,
        ws.prefix,
        bool(ws.closed),
        ws.closedAt,
        prev?.firstSeenAt ?? archivedFirstSeen.get(ws.id) ?? now,
        now,
      );
      deleteMembers.run(ws.id);
      for (const m of members) insertMember.run(ws.id, m.key, m.position, m.parent, bool(m.listingOnly));
    }

    const keep = new Set(workstreams.map((w) => w.id));
    const nowMs = Date.parse(now);
    for (const w of before) {
      if (keep.has(w.id)) continue;
      changedIds.add(w.id);
      deleteMembers.run(w.id);
      const recentlyClosed = w.closed && w.closedAt !== null && nowMs - Date.parse(w.closedAt) <= ARCHIVE_MS;
      if (recentlyClosed || w.manualName !== null) {
        db.query("UPDATE workstreams SET archived = 1, updated_at = ? WHERE id = ?").run(now, w.id);
      } else {
        db.query("DELETE FROM workstreams WHERE id = ?").run(w.id);
      }
    }
    for (const [id] of archivedFirstSeen) {
      if (keep.has(id)) continue;
      const row = db
        .query<{ closed_at: string | null; updated_at: string }, [string]>(
          "SELECT closed_at, updated_at FROM workstreams WHERE id = ?",
        )
        .get(id);
      if (!row || nowMs - Date.parse(row.closed_at ?? row.updated_at) > ARCHIVE_MS) {
        db.query("DELETE FROM workstreams WHERE id = ?").run(id);
      }
    }

    const changedKeys: SubjectKey[] = [];
    for (const key of new Set([...oldSig.keys(), ...newSig.keys()])) {
      if (oldSig.get(key) !== newSig.get(key)) changedKeys.push(key);
    }
    changedKeys.sort();
    for (const key of changedKeys) appendChange(db, "stack", key, now);
    const ids = [...changedIds].sort();
    for (const id of ids) appendChange(db, "workstream", id, now);
    return { changedKeys, changedIds: ids };
  })();
}

/** Sets or clears (null) the manual name. Appends a `workstream` change. */
export function setManualName(db: Database, id: string, name: string | null, now: string): void {
  db.transaction(() => {
    db.query("UPDATE workstreams SET manual_name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
    appendChange(db, "workstream", id, now);
  })();
}

export function listOverrides(db: Database, repo: string): StoredOverride[] {
  return db
    .query<OverrideRow, [string]>("SELECT * FROM workstream_overrides WHERE repo = ? ORDER BY id")
    .all(repo)
    .map((r) => ({
      id: r.id,
      repo: r.repo,
      override: JSON.parse(r.payload_json) as WsOverride,
      createdAt: r.created_at,
    }));
}

export function addOverride(db: Database, repo: string, override: WsOverride, now: string): number {
  const row = db
    .query<{ id: number }, [string, string, string, string]>(
      `INSERT INTO workstream_overrides (repo, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .get(repo, override.kind, toJson(override), now);
  if (!row) throw new Error("insert into workstream_overrides returned no row");
  return row.id;
}

export function updateOverride(db: Database, id: number, override: WsOverride): void {
  db.query("UPDATE workstream_overrides SET payload_json = ? WHERE id = ?").run(toJson(override), id);
}

export function deleteOverride(db: Database, id: number): void {
  db.query("DELETE FROM workstream_overrides WHERE id = ?").run(id);
}

function stateFromRow(r: WorkstreamStateRow): WorkstreamState {
  return {
    priority: r.priority as WsPriority,
    seenAt: r.seen_at,
    seenSummaryHash: r.seen_summary_hash,
    snoozeUntil: r.snooze_until,
    snoozeUntilHumanEvent: r.snooze_until_human_event !== 0,
    snoozeUntilReady: r.snooze_until_ready !== 0,
    snoozedAt: r.snoozed_at,
  };
}

export function getWorkstreamState(db: Database, id: string): WorkstreamState {
  const row = db
    .query<WorkstreamStateRow, [string]>("SELECT * FROM workstream_state WHERE workstream_id = ?")
    .get(id);
  return row ? stateFromRow(row) : { ...DEFAULT_WORKSTREAM_STATE };
}

/** States for the given workstreams. Ids without a stored row are absent from the map. */
/** Workstreams whose snooze ended in `(after, until]`; `after` null means any time up to `until`. */
export function workstreamSnoozesEndedBetween(
  db: Database,
  after: string | null,
  until: string,
): string[] {
  return db
    .query<{ workstream_id: string }, [string, string]>(
      `SELECT workstream_id FROM workstream_state
       WHERE snooze_until IS NOT NULL AND snooze_until > ? AND snooze_until <= ?
       ORDER BY workstream_id`,
    )
    .all(after ?? "", until)
    .map((r) => r.workstream_id);
}

export function getWorkstreamStates(db: Database, ids: string[]): Map<string, WorkstreamState> {
  const rows = db
    .query<WorkstreamStateRow, [string]>(
      "SELECT * FROM workstream_state WHERE workstream_id IN (SELECT value FROM json_each(?))",
    )
    .all(jsonList(ids));
  return new Map(rows.map((r) => [r.workstream_id, stateFromRow(r)]));
}

/** Replaces a workstream's state and appends a `workstream` change in the same transaction. */
export function putWorkstreamState(db: Database, id: string, state: WorkstreamState, now: string): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO workstream_state (workstream_id, priority, seen_at, seen_summary_hash, snooze_until,
         snooze_until_human_event, snooze_until_ready, snoozed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workstream_id) DO UPDATE SET
         priority = excluded.priority, seen_at = excluded.seen_at,
         seen_summary_hash = excluded.seen_summary_hash, snooze_until = excluded.snooze_until,
         snooze_until_human_event = excluded.snooze_until_human_event,
         snooze_until_ready = excluded.snooze_until_ready, snoozed_at = excluded.snoozed_at,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      state.priority,
      state.seenAt,
      state.seenSummaryHash,
      state.snoozeUntil,
      bool(state.snoozeUntilHumanEvent),
      bool(state.snoozeUntilReady),
      state.snoozedAt,
      now,
    );
    appendChange(db, "workstream", id, now);
  })();
}

interface FactRow {
  subject_key: string;
  typename: string;
  login: string | null;
}

/**
 * Involvement facts for stored subjects: author, open review requests, reviewers, commenters
 * and the view section when the subject has a notification thread. Keys without a subjects
 * row are absent; callers fill those from the listing.
 */
export function memberFacts(db: Database, keys: string[]): Map<SubjectKey, MemberFacts> {
  const list = jsonList(keys);
  const subjects = db
    .query<{ subject_key: string; author: string | null; section: string | null; threads: number }, [string]>(
      `SELECT s.subject_key, s.author, v.section,
         (SELECT COUNT(*) FROM threads t WHERE t.subject_key = s.subject_key) AS threads
       FROM subjects s LEFT JOIN subject_views v ON v.subject_key = s.subject_key
       WHERE s.subject_key IN (SELECT value FROM json_each(?))`,
    )
    .all(list);
  const out = new Map<SubjectKey, MemberFacts>();
  for (const s of subjects) {
    out.set(s.subject_key, {
      author: s.author,
      requestedReviewers: [],
      reviewers: [],
      commenters: [],
      // A thread whose view is not derived yet counts as visible.
      threadSection: s.threads > 0 ? ((s.section as Section | null) ?? "updates") : null,
    });
  }

  const items = db
    .query<FactRow, [string]>(
      `SELECT subject_key, typename,
         COALESCE(json_extract(raw_json, '$.requestedReviewer.login'),
                  json_extract(raw_json, '$.author.login')) AS login
       FROM timeline_items
       WHERE subject_key IN (SELECT value FROM json_each(?))
         AND typename IN ('ReviewRequestedEvent', 'ReviewRequestRemovedEvent',
                          'PullRequestReview', 'IssueComment')
       ORDER BY created_at, node_id`,
    )
    .all(list);
  const requested = new Map<SubjectKey, string[]>();
  for (const it of items) {
    const facts = out.get(it.subject_key);
    if (!facts || it.login === null) continue;
    const login = it.login;
    const open = requested.get(it.subject_key) ?? [];
    switch (it.typename) {
      case "ReviewRequestedEvent":
        if (!open.includes(login)) open.push(login);
        break;
      case "ReviewRequestRemovedEvent": {
        const i = open.indexOf(login);
        if (i >= 0) open.splice(i, 1);
        break;
      }
      case "PullRequestReview":
        if (!facts.reviewers.includes(login)) facts.reviewers.push(login);
        break;
      case "IssueComment":
        if (!facts.commenters.includes(login)) facts.commenters.push(login);
        break;
    }
    requested.set(it.subject_key, open);
  }
  for (const [key, open] of requested) {
    const facts = out.get(key);
    if (facts) facts.requestedReviewers = open;
  }
  return out;
}
