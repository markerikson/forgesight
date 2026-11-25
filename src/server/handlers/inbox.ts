import {
  type InboxPayload,
  type InboxRow,
  type WorkstreamInput,
  buildInboxPayload,
} from "../../core/index.ts";
import type { SubjectKey } from "../../core/types.ts";
import { isShownWorkstream, type MemberFacts, workstreamSnoozeActive } from "../../core/workstream-state.ts";
import { listViews } from "../../store/views.ts";
import { getWorkstreamStates, listWorkstreams, memberFacts, toWorkstream } from "../../store/workstreams.ts";
import type { ServerCtx } from "../ctx.ts";
import { workerConfig } from "./derive-now.ts";

/**
 * Every workstream that gets a row: Mark is involved in a member, or has not seen it yet.
 * Members with no subject row (listing-only) count as authored by the stack's author.
 */
export function loadWorkstreamInputs(ctx: ServerCtx): WorkstreamInput[] {
  const stored = listWorkstreams(ctx.db);
  if (stored.length === 0) return [];
  const me = workerConfig(ctx, ctx.db).me ?? null;
  const now = ctx.now();
  const keys = stored.flatMap((w) => w.members.map((m) => m.key));
  const facts = new Map<SubjectKey, MemberFacts>(memberFacts(ctx.db, keys));
  const states = getWorkstreamStates(
    ctx.db,
    stored.map((w) => w.id),
  );
  const inputs: WorkstreamInput[] = [];
  for (const s of stored) {
    for (const m of s.members) {
      if (!facts.has(m.key)) {
        facts.set(m.key, { author: s.author, requestedReviewers: [], reviewers: [], commenters: [], threadSection: null });
      }
    }
    const workstream = toWorkstream(s);
    const state = states.get(s.id) ?? null;
    if (!isShownWorkstream(workstream, facts, me, state?.seenAt ?? null)) continue;
    // Wake on time only; human-event and ready wakes need member events the inbox read does not load.
    const snoozed = state !== null && workstreamSnoozeActive(state, [], me, now);
    // PLACEHOLDER: replaced by m4-llm branch at merge (latest summary per workstream id).
    inputs.push({ workstream, state, summary: null, snoozed });
  }
  return inputs;
}

export function readInbox(ctx: ServerCtx, includeHidden: boolean): InboxPayload {
  // The worker writes `row` with `toViewRecord`, so the stored JSON is an InboxRow.
  const rows = listViews(ctx.db, { includeHidden: true }).map((view) => view.row as unknown as InboxRow);
  return buildInboxPayload(rows, { includeHidden, now: ctx.now(), workstreams: loadWorkstreamInputs(ctx) });
}

export async function inboxHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const includeHidden = new URL(req.url).searchParams.get("includeHidden") === "1";
  return Response.json(readInbox(ctx, includeHidden));
}
