// PLACEHOLDER: replaced by m4-core|m4-store|m4-llm branch at merge.
// Stand-ins for the shapes the parallel M4 branches define, so the UI can build against
// them. At merge, point the imports at the real modules and delete this file.
import type { InboxGroup } from "./inbox.ts";
import type { InboxRow } from "./pipeline/types.ts";
import type { SubjectKey } from "./types.ts";

// PLACEHOLDER: replaced by m4-core branch at merge (src/core/workstreams.ts).
export interface Workstream {
  id: string;
  repo: string;
  /** Title prefix or branch-derived name. */
  name: string;
  /** Subject keys in stack order, base of the stack first. */
  members: SubjectKey[];
  edges: { child: SubjectKey; parent: SubjectKey }[];
  signals: ("stack" | "sharedBase" | "titlePrefix" | "manual")[];
  closed: boolean;
}

// PLACEHOLDER: replaced by m4-core branch at merge (src/core/workstreams.ts).
export interface StackContext {
  workstreamId: string;
  parent: SubjectKey | null;
  children: SubjectKey[];
  /** 1-based position in stack order. */
  position: number;
  size: number;
}

// PLACEHOLDER: replaced by m4-core branch at merge (src/core/workstreams.ts).
export function stackContext(ws: Workstream, key: SubjectKey): StackContext | null {
  const index = ws.members.indexOf(key);
  if (index === -1) return null;
  return {
    workstreamId: ws.id,
    parent: ws.edges.find((e) => e.child === key)?.parent ?? null,
    children: ws.edges.filter((e) => e.parent === key).map((e) => e.child),
    position: index + 1,
    size: ws.members.length,
  };
}

export type WorkstreamPriority = "normal" | "low" | "muted";

// PLACEHOLDER: replaced by m4-store branch at merge (workstream_state row as the inbox reads it).
export interface WorkstreamStateView {
  priority: WorkstreamPriority;
  /** Manual rename; wins over the generated name and the title prefix. */
  name: string | null;
  seenAt: string | null;
  seenSummaryHash: string | null;
  snoozeUntil: string | null;
  snoozeUntilHumanEvent: boolean;
  snoozeUntilReady: boolean;
  snoozedAt: string | null;
}

// PLACEHOLDER: replaced by m4-llm branch at merge (latest summary per workstream id).
export interface WorkstreamSummaryRecord {
  /** Suggested name from the summary prompt. */
  name: string | null;
  text: string;
  status: string | null;
  generatedAt: string;
  hash: string;
}

// PLACEHOLDER: replaced by m4-store branch at merge (workstream state ops, target {kind:"workstream", id}).
export type WorkstreamOp =
  | { kind: "setPriority"; priority: WorkstreamPriority }
  | { kind: "snooze"; until: string | null; untilHumanEvent: boolean; untilReady: boolean }
  | { kind: "unsnooze" }
  | { kind: "rename"; name: string | null }
  | { kind: "seen"; summaryHash: string | null }
  | { kind: "removeMember"; key: SubjectKey }
  | { kind: "merge"; into: string };

// PLACEHOLDER: replaced by m4-store branch at merge.
export interface WorkstreamTarget {
  kind: "workstream";
  id: string;
}

// PLACEHOLDER: replaced by m4-store branch at merge (POST /api/state with a workstream target).
export interface WorkstreamStateRequest {
  target: WorkstreamTarget;
  op: WorkstreamOp;
}

// PLACEHOLDER: replaced by m4-store branch at merge. The server answers with the group as the
// inbox now builds it (null when it is gone, e.g. merged away) and any member rows that moved.
export interface WorkstreamStateResponse {
  opId: number;
  rows: Record<SubjectKey, InboxRow>;
  groups: Record<string, InboxGroup | null>;
}
