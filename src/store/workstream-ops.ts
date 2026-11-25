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

function firstMember(db: Database, id: string): string {
  const key = getWorkstream(db, id)?.members[0]?.key;
  if (!key) throw new Error(`workstream ${id} has no members`);
  return key;
}

function overrideFor(db: Database, id: string, op: WorkstreamOp): WsOverride | null {
  switch (op.kind) {
    case "merge":
      return { kind: "merge", keys: [firstMember(db, id), firstMember(db, op.from)] };
    case "remove":
      return { kind: "remove", key: op.key };
    default:
      return null;
  }
}

/**
 * Applies `op` to workstream `id` in one transaction and records it for undo. State ops
 * write `workstream_state`; rename sets `manual_name`, which wins over the detected name;
 * merge and remove add an override row that the next rebuild applies. The caller rebuilds
 * and re-derives.
 */
export function applyWorkstreamOps(db: Database, id: string, op: WorkstreamOp, now: string): { opId: number } {
  return db.transaction(() => {
    const ws = getWorkstream(db, id);
    if (!ws) throw new Error(`unknown workstream ${id}`);
    const state = getWorkstreamState(db, id);
    const override = overrideFor(db, id, op);
    const overrideId = override ? addOverride(db, ws.repo, override, now) : null;
    const prev: Record<string, WorkstreamPrev> = {
      [wsPrevKey(id)]: { state, manualName: ws.manualName, overrideId },
    };
    if (op.kind === "merge") {
      const from = getWorkstream(db, op.from);
      prev[wsPrevKey(op.from)] = {
        state: getWorkstreamState(db, op.from),
        manualName: from?.manualName ?? null,
        overrideId: null,
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

/** Restores what a workstream op replaced. Runs inside `undoStateOp`'s transaction. */
export function restoreWorkstreamOp(db: Database, record: WorkstreamOpRecord, prevJson: string, now: string): void {
  const prev = JSON.parse(prevJson) as Record<string, WorkstreamPrev>;
  const own = prev[wsPrevKey(record.target.id)];
  if (!own) return;
  if (own.overrideId !== null) deleteOverride(db, own.overrideId);
  if (isWorkstreamStateOp(record.op)) putWorkstreamState(db, record.target.id, own.state, now);
  else if (record.op.kind === "rename" && getWorkstream(db, record.target.id))
    setManualName(db, record.target.id, own.manualName, now);
}
