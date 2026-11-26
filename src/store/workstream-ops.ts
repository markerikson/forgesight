// Workstream ops share the `state_ops` undo log with subject ops. Their `op_json` is
// `{ target, op }` and their `prev_json` keys are `ws:<id>`, so the newer-op check in
// `undoStateOp` works across both kinds without colliding with subject keys.
import type { Database } from "bun:sqlite";
import {
  applyWorkstreamOp,
  isWorkstreamStateOp,
  type WorkstreamOp,
  type WorkstreamState,
  type WorkstreamTarget,
} from "../core/workstream-state.ts";
import type { WsOverride } from "../core/workstreams.ts";
import { toJson } from "./rows.ts";
import {
  addOverride,
  deleteOverride,
  getWorkstream,
  getWorkstreamState,
  putWorkstreamState,
  setManualName,
} from "./workstreams.ts";

export interface WorkstreamPrev {
  state: WorkstreamState;
  manualName: string | null;
  /** Override row the op added, deleted on undo. */
  overrideId: number | null;
  /** Merge only: the members before the merge, so undo gives each half its old ID back. */
  members?: string[];
}

export interface WorkstreamOpRecord {
  target: WorkstreamTarget;
  op: WorkstreamOp;
}

export const wsPrevKey = (id: string) => `ws:${id}`;

export function parseWorkstreamOpRecord(opJson: string): WorkstreamOpRecord | null {
  const parsed = JSON.parse(opJson) as Partial<WorkstreamOpRecord>;
  return parsed.target?.kind === "workstream" && parsed.op ? (parsed as WorkstreamOpRecord) : null;
}

/**
 * The member a merge override points at: the stack top, which usually merges last. The
 * rebuild moves the anchor to another member once this one leaves the pull set.
 */
function anchorMember(db: Database, id: string): string {
  const key = getWorkstream(db, id)?.members.at(-1)?.key;
  if (!key) throw new Error(`workstream ${id} has no members`);
  return key;
}

function overrideFor(db: Database, id: string, op: WorkstreamOp): WsOverride | null {
  switch (op.kind) {
    case "merge":
      return { kind: "merge", keys: [anchorMember(db, id), anchorMember(db, op.from)] };
    case "remove":
      return { kind: "remove", key: op.key };
    case "add":
      return { kind: "merge", keys: [anchorMember(db, id), op.key] };
    default:
      return null;
  }
}

/**
 * Applies `op` to workstream `id` in one transaction and records it for undo. State ops
 * write `workstream_state`; rename sets `manual_name`, which wins over the detected name;
 * merge, remove and add add an override row that the next rebuild applies. The caller rebuilds
 * and re-derives.
 */
export function applyWorkstreamOps(db: Database, id: string, op: WorkstreamOp, now: string): { opId: number } {
  return db.transaction(() => {
    const ws = getWorkstream(db, id);
    if (!ws) throw new Error(`unknown workstream ${id}`);
    const state = getWorkstreamState(db, id);
    const override = overrideFor(db, id, op);
    const overrideId = override ? addOverride(db, ws.repo, override, now) : null;
    const own: WorkstreamPrev = { state, manualName: ws.manualName, overrideId };
    const prev: Record<string, WorkstreamPrev> = { [wsPrevKey(id)]: own };
    if (op.kind === "merge") {
      const from = getWorkstream(db, op.from);
      own.members = ws.members.map((m) => m.key);
      prev[wsPrevKey(op.from)] = {
        state: getWorkstreamState(db, op.from),
        manualName: from?.manualName ?? null,
        overrideId: null,
        members: from?.members.map((m) => m.key) ?? [],
      };
    }

    if (isWorkstreamStateOp(op)) putWorkstreamState(db, id, applyWorkstreamOp(state, op, now), now);
    else if (op.kind === "rename") setManualName(db, id, op.name, now);

    const record: WorkstreamOpRecord = { target: { kind: "workstream", id }, op };
    const opId = Number(
      db
        .query("INSERT INTO state_ops (created_at, op_json, prev_json) VALUES (?, ?, ?)")
        .run(now, toJson(record), toJson(prev)).lastInsertRowid,
    );
    return { opId };
  })();
}

/** For undoing a merge: each workstream's members before the merge, with its ID. */
export function mergeUndoHints(prevJson: string): { keys: string[]; id: string }[] {
  const prev = JSON.parse(prevJson) as Record<string, WorkstreamPrev>;
  return Object.entries(prev).flatMap(([key, entry]) =>
    key.startsWith("ws:") && entry.members ? [{ keys: entry.members, id: key.slice(3) }] : [],
  );
}

/** Whether a live `seen` op on workstream `id` came after op `opId`. */
function seenSince(db: Database, id: string, opId: number): boolean {
  const row = db
    .query<{ id: number }, [number, string]>(
      `SELECT id FROM state_ops
       WHERE id > ? AND undone_at IS NULL
         AND json_extract(op_json, '$.op.kind') = 'seen'
         AND json_extract(op_json, '$.target.id') = ?
       LIMIT 1`,
    )
    .get(opId, id);
  return row !== null;
}

/**
 * Restores what workstream op `opId` replaced. Runs inside `undoStateOp`'s transaction. A
 * later `seen` op does not block the undo, so its seen fields survive the restore.
 */
export function restoreWorkstreamOp(
  db: Database,
  opId: number,
  record: WorkstreamOpRecord,
  prevJson: string,
  now: string,
): void {
  const prev = JSON.parse(prevJson) as Record<string, WorkstreamPrev>;
  const id = record.target.id;
  const own = prev[wsPrevKey(id)];
  if (!own) return;
  if (own.overrideId !== null) deleteOverride(db, own.overrideId);
  if (isWorkstreamStateOp(record.op)) {
    let state = own.state;
    if (seenSince(db, id, opId)) {
      const { seenAt, seenSummaryHash } = getWorkstreamState(db, id);
      state = { ...state, seenAt, seenSummaryHash };
    }
    putWorkstreamState(db, id, state, now);
  }
  else if (record.op.kind === "rename" && getWorkstream(db, record.target.id))
    setManualName(db, record.target.id, own.manualName, now);
  else if (record.op.kind === "merge") {
    // The absorbed row may be archived; the rebuild after undo un-archives it with this name.
    for (const [key, entry] of Object.entries(prev)) {
      if (key.startsWith("ws:")) setManualName(db, key.slice(3), entry.manualName, now);
    }
  }
}
