import {
  type InboxPayload,
  type InboxRow,
  type ListedPull,
  type WorkstreamInput,
  buildInboxPayload,
} from "../../core/index.ts";
import type { SubjectKey } from "../../core/types.ts";
import { isListedWorkstream, type MemberFacts, workstreamSnoozeActive } from "../../core/workstream-state.ts";
import { latestWorkstreamSummaries } from "../../store/llm.ts";
import { getPrTexts } from "../../store/pr-texts.ts";
import { readListing } from "../../worker/workstreams.ts";
import { listViews } from "../../store/views.ts";
import {
  firstWorkstreamBuilds,
  getWorkstreamStates,
  listWorkstreams,
  memberFacts,
  toWorkstream,
} from "../../store/workstreams.ts";
import type { ServerCtx } from "../ctx.ts";
import { withoutQuietDone, workerConfig } from "./derive-now.ts";

/**
 * Every workstream that gets a row: Mark is involved in a member, has not seen it yet, or
 * muted it (it shows in Hidden).
 * Members with no subject row (listing-only) count as authored by the stack's author.
 */
export function loadWorkstreamInputs(ctx: ServerCtx, rowKeys: ReadonlySet<SubjectKey> = new Set()): WorkstreamInput[] {
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
  const summaries = latestWorkstreamSummaries(ctx.db);
  const firstBuilds = firstWorkstreamBuilds(ctx.db);
  const inputs: WorkstreamInput[] = [];
  for (const s of stored) {
    for (const m of s.members) {
      if (!facts.has(m.key)) {
        facts.set(m.key, { author: s.author, requestedReviewers: [], reviewers: [], commenters: [], threadSection: null });
      }
    }
    const workstream = toWorkstream(s);
    const state = states.get(s.id) ?? null;
    if (!isListedWorkstream(workstream, facts, me, state)) continue;
    // Wake on time only; human-event and ready wakes need member events the inbox read does not load.
    const snoozed = state !== null && workstreamSnoozeActive(state, [], me, now);
    const pulls = listedPulls(
      ctx,
      s.repo,
      workstream.members.filter((key) => !rowKeys.has(key)),
    );
    const repoFirstSeenAt = firstBuilds.get(s.repo);
    inputs.push({
      workstream,
      state,
      summary: summaries.get(s.id) ?? null,
      snoozed,
      pulls,
      rootBody: rootBody(ctx, s.repo, workstream.members[0], rowKeys),
      firstSeenAt: s.firstSeenAt,
      ...(repoFirstSeenAt === undefined ? {} : { repoFirstSeenAt }),
    });
  }
  return inputs;
}

const PULL_NUMBER = /#(\d+)$/;

/** Title, state and URL of members with no inbox row, from the open-PR listing, else stored PR texts. */
export function listedPulls(ctx: ServerCtx, repo: string, keys: SubjectKey[]): Record<SubjectKey, ListedPull> {
  const out: Record<SubjectKey, ListedPull> = {};
  if (keys.length === 0) return out;
  const numbers = new Map<number, SubjectKey>();
  for (const key of keys) {
    const match = PULL_NUMBER.exec(key);
    if (match) numbers.set(Number(match[1]), key);
  }
  const open = new Map((readListing(ctx.db, repo)?.pulls ?? []).map((p) => [p.number, p]));
  const texts = getPrTexts(
    ctx.db,
    repo,
    [...numbers.keys()].filter((n) => !open.has(n)),
  );
  for (const [number, key] of numbers) {
    const url = `https://github.com/${repo}/pull/${number}`;
    const pull = open.get(number);
    const text = texts.get(number);
    if (pull) {
      out[key] = {
        number,
        title: pull.title,
        url,
        state: "OPEN",
        draft: pull.isDraft,
        author: pull.author,
        updatedAt: pull.updatedAt,
      };
    } else if (text) {
      out[key] = {
        number,
        title: text.title,
        url,
        state: text.state,
        draft: text.isDraft,
        author: null,
        updatedAt: text.updatedAt,
      };
    }
  }
  return out;
}

/** The stored description of a workstream's first member, when it has no inbox row to load it from. */
function rootBody(ctx: ServerCtx, repo: string, root: SubjectKey | undefined, rowKeys: ReadonlySet<SubjectKey>): string | null {
  if (root === undefined || rowKeys.has(root)) return null;
  const match = PULL_NUMBER.exec(root);
  if (!match) return null;
  const body = getPrTexts(ctx.db, repo, [Number(match[1])]).get(Number(match[1]))?.body.trim();
  return body ? body : null;
}

export function readInbox(ctx: ServerCtx, includeHidden: boolean): InboxPayload {
  // The worker writes `row` with `toViewRecord`, so the stored JSON is an InboxRow.
  const rows = listViews(ctx.db, { includeHidden: true }).map((view) => view.row as unknown as InboxRow);
  // Keys of every row, Done ones included, so a Done member is not listed as having no thread.
  const rowKeys = new Set(rows.map((r) => r.key));
  return buildInboxPayload(withoutQuietDone(ctx.db, rows), {
    includeHidden,
    now: ctx.now(),
    workstreams: loadWorkstreamInputs(ctx, rowKeys),
  });
}

export async function inboxHandler(req: Request, ctx: ServerCtx): Promise<Response> {
  const includeHidden = new URL(req.url).searchParams.get("includeHidden") === "1";
  return Response.json(readInbox(ctx, includeHidden));
}
