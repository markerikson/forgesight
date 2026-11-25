import type { Database } from "bun:sqlite";
import { type Config, type InboxRow, isDoneQuiet, type SubjectKey } from "../../core/index.ts";
import { META } from "../../core/meta-keys.ts";
import type { WorkstreamState } from "../../core/workstream-state.ts";
import { getItemStates } from "../../store/item-state.ts";
import { getMeta } from "../../store/meta.ts";
import { getView } from "../../store/views.ts";
import type { WorkstreamOpRecord } from "../../store/workstream-ops.ts";
import { getWorkstream, getWorkstreamState, type StoredWorkstream } from "../../store/workstreams.ts";
import { deriveKeys } from "../../worker/derive.ts";
import { rebuildWorkstreams, type WorkstreamIdHint } from "../../worker/workstreams.ts";
import type { ServerCtx } from "../ctx.ts";

/** The config with the worker's `me` fallback, so stored config hashes match the worker's. */
export function workerConfig(ctx: ServerCtx, db: Database): Config {
  return ctx.config.me ? ctx.config : { ...ctx.config, me: getMeta(db, META.viewerLogin) ?? null };
}

/** Drops rows marked Done with no activity since, so they leave Hidden and its counts. */
export function withoutQuietDone(db: Database, rows: InboxRow[]): InboxRow[] {
  const hidden = rows.filter((r) => r.section === "hidden").map((r) => r.key);
  if (hidden.length === 0) return rows;
  const states = getItemStates(db, hidden);
  return rows.filter((r) => !isDoneQuiet(r, states.get(r.key)?.doneAt ?? null));
}

/**
 * Derives `keys` right away on the write connection so the response, and any inbox refetch
 * an SSE event triggers, already shows the new state. Rows marked Done with nothing new are
 * left out, as the inbox read leaves them out.
 */
export function deriveNow(ctx: ServerCtx, db: Database, keys: SubjectKey[]): Record<SubjectKey, InboxRow> {
  deriveKeys(db, keys, workerConfig(ctx, db), ctx.now());
  const views: InboxRow[] = [];
  for (const key of keys) {
    const view = getView(db, key);
    if (view) views.push(view.row as unknown as InboxRow);
  }
  const rows: Record<SubjectKey, InboxRow> = {};
  for (const row of withoutQuietDone(db, views)) rows[row.key] = row;
  return rows;
}

export interface WorkstreamSnapshot extends StoredWorkstream {
  state: WorkstreamState;
}

export interface WorkstreamOpEffects {
  rows: Record<SubjectKey, InboxRow>;
  /** Each workstream the op named, after the op; null when it no longer exists (merged away). */
  workstreams: Record<string, WorkstreamSnapshot | null>;
}

export function workstreamIdsOf(record: WorkstreamOpRecord): string[] {
  return record.op.kind === "merge" ? [record.target.id, record.op.from] : [record.target.id];
}

export function snapshot(db: Database, id: string): WorkstreamSnapshot | null {
  const ws = getWorkstream(db, id);
  return ws ? { ...ws, state: getWorkstreamState(db, id) } : null;
}

const STRUCTURAL = new Set(["rename", "merge", "remove"]);

/**
 * After a workstream op or its undo: rebuilds the repo's workstreams from the stored
 * listing when the op edited names or membership, then re-derives every subject whose
 * membership may have changed. `before` holds the named workstreams before the change.
 */
export function afterWorkstreamOp(
  ctx: ServerCtx,
  db: Database,
  record: WorkstreamOpRecord,
  before: readonly StoredWorkstream[],
  idHints: readonly WorkstreamIdHint[] = [],
): WorkstreamOpEffects {
  const ids = workstreamIdsOf(record);
  const keys = new Set<SubjectKey>();
  if (STRUCTURAL.has(record.op.kind)) {
    for (const ws of before) for (const m of ws.members) keys.add(m.key);
    const repo = before[0]?.repo;
    if (repo) {
      const rebuilt = rebuildWorkstreams(db, workerConfig(ctx, db), repo, ctx.now(), idHints);
      for (const key of rebuilt?.changedKeys ?? []) keys.add(key);
    }
    for (const id of ids) for (const m of getWorkstream(db, id)?.members ?? []) keys.add(m.key);
  }
  const workstreams: Record<string, WorkstreamSnapshot | null> = {};
  for (const id of ids) workstreams[id] = snapshot(db, id);
  return { rows: keys.size > 0 ? deriveNow(ctx, db, [...keys].sort()) : {}, workstreams };
}
