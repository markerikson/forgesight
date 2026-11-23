import { type } from "arktype";
import type {
  ItemState,
  ReviewThreadRecord,
  StickyCommentVersion,
  SubjectKind,
  SubjectOrigin,
  SubjectRecord,
  SubjectState,
  SubjectViewRecord,
  ThreadRecord,
  TimelineItemRecord,
} from "../core/types.ts";

// Row shapes as SQLite returns them (snake_case, integers for booleans).

export interface ThreadRow {
  thread_id: string;
  subject_key: string;
  repo: string;
  subject_type: string;
  reason: string;
  unread: number;
  updated_at: string;
  last_read_at: string | null;
  first_seen_at: string;
  gh_done_at: string | null;
  subject_url: string | null;
  raw_json: string;
}

export interface SubjectRow {
  subject_key: string;
  repo: string;
  number: number | null;
  kind: string;
  node_id: string | null;
  origin: string;
  state: string | null;
  author: string | null;
  head_ref: string | null;
  base_ref: string | null;
  head_sha: string | null;
  base_sha: string | null;
  updated_at: string | null;
  timeline_synced_until: string | null;
  dirty_at: string | null;
  priority: number;
  enrich_error: string | null;
  enrich_attempts: number;
  raw_json: string | null;
}

export interface TimelineItemRow {
  node_id: string;
  subject_key: string;
  typename: string;
  created_at: string;
  raw_json: string;
  fetched_at: string;
}

export interface ReviewThreadRow {
  node_id: string;
  subject_key: string;
  is_resolved: number;
  is_outdated: number;
  path: string | null;
  line: number | null;
  raw_json: string;
  fetched_at: string;
}

export interface StickyVersionRow {
  comment_node_id: string;
  body_hash: string;
  subject_key: string;
  author: string;
  last_edited_at: string | null;
  seen_at: string;
  body: string;
}

export interface ItemStateRow {
  subject_key: string;
  dismissed_at: string | null;
  keep_unread: number;
  snooze_until: string | null;
  snooze_until_human_event: number;
  muted: number;
  updated_at: string;
}

export interface SubjectViewRow {
  subject_key: string;
  pipeline_version: number;
  config_hash: string;
  section: string;
  sort_at: string;
  score: number;
  repo: string;
  stack_id: string | null;
  row_json: string;
  detail_json: string;
  computed_at: string;
}

/** `row_json` of `subject_views`. Pipeline-v0 replaces this with the real row shape. */
export const viewRowSchema = type("Record<string, unknown>");
/** `detail_json` of `subject_views`. Pipeline-v0 replaces this with the real detail shape. */
export const viewDetailSchema = type("Record<string, unknown>");

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function parseWith<T>(schema: (data: unknown) => T | type.errors, text: string, where: string): T {
  const out = schema(parseJson(text));
  if (out instanceof type.errors) throw new Error(`Invalid ${where}: ${out.summary}`);
  return out;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function threadFromRow(r: ThreadRow): ThreadRecord {
  return {
    threadId: r.thread_id,
    subjectKey: r.subject_key,
    repo: r.repo,
    subjectType: r.subject_type,
    reason: r.reason,
    unread: r.unread !== 0,
    updatedAt: r.updated_at,
    lastReadAt: r.last_read_at,
    firstSeenAt: r.first_seen_at,
    ghDoneAt: r.gh_done_at,
    subjectUrl: r.subject_url,
    raw: parseJson(r.raw_json),
  };
}

export function subjectFromRow(r: SubjectRow): SubjectRecord {
  return {
    subjectKey: r.subject_key,
    repo: r.repo,
    number: r.number,
    kind: r.kind as SubjectKind,
    nodeId: r.node_id,
    origin: r.origin as SubjectOrigin,
    state: r.state as SubjectState | null,
    author: r.author,
    headRef: r.head_ref,
    baseRef: r.base_ref,
    headSha: r.head_sha,
    baseSha: r.base_sha,
    updatedAt: r.updated_at,
    timelineSyncedUntil: r.timeline_synced_until,
    dirtyAt: r.dirty_at,
    priority: r.priority,
    enrichError: r.enrich_error,
    enrichAttempts: r.enrich_attempts,
    raw: r.raw_json === null ? null : parseJson(r.raw_json),
  };
}

export function timelineItemFromRow(r: TimelineItemRow): TimelineItemRecord {
  return {
    nodeId: r.node_id,
    subjectKey: r.subject_key,
    typename: r.typename,
    createdAt: r.created_at,
    raw: parseJson(r.raw_json),
    fetchedAt: r.fetched_at,
  };
}

export function reviewThreadFromRow(r: ReviewThreadRow): ReviewThreadRecord {
  return {
    nodeId: r.node_id,
    subjectKey: r.subject_key,
    isResolved: r.is_resolved !== 0,
    isOutdated: r.is_outdated !== 0,
    path: r.path,
    line: r.line,
    raw: parseJson(r.raw_json),
    fetchedAt: r.fetched_at,
  };
}

export function stickyFromRow(r: StickyVersionRow): StickyCommentVersion {
  return {
    commentNodeId: r.comment_node_id,
    bodyHash: r.body_hash,
    subjectKey: r.subject_key,
    author: r.author,
    lastEditedAt: r.last_edited_at,
    seenAt: r.seen_at,
    body: r.body,
  };
}

export function itemStateFromRow(r: ItemStateRow): ItemState {
  return {
    dismissedAt: r.dismissed_at,
    keepUnread: r.keep_unread !== 0,
    snoozeUntil: r.snooze_until,
    snoozeUntilHumanEvent: r.snooze_until_human_event !== 0,
    muted: r.muted !== 0,
  };
}

export function viewFromRow(r: SubjectViewRow): SubjectViewRecord {
  return {
    subjectKey: r.subject_key,
    pipelineVersion: r.pipeline_version,
    configHash: r.config_hash,
    section: r.section,
    sortAt: r.sort_at,
    score: r.score,
    repo: r.repo,
    stackId: r.stack_id,
    row: parseWith(viewRowSchema, r.row_json, `row_json for ${r.subject_key}`),
    detail: parseWith(viewDetailSchema, r.detail_json, `detail_json for ${r.subject_key}`),
    computedAt: r.computed_at,
  };
}

/** Use with `IN (SELECT value FROM json_each(?))` so one cached statement serves any list length. */
export function jsonList(values: string[]): string {
  return JSON.stringify(values);
}

export function bool(value: boolean): number {
  return value ? 1 : 0;
}
