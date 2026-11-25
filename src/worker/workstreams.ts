import type { Database } from "bun:sqlite";
import type { Config } from "../core/config.ts";
import { repoConfig } from "../core/config.ts";
import { META, openPullsMetaKey, recentlyClosedMetaKey } from "../core/meta-keys.ts";
import { type ClosedPull, groupingPulls, RECENTLY_CLOSED_MS } from "../core/recently-closed.ts";
import type { SubjectKey } from "../core/types.ts";
import { isShownWorkstream, type MemberFacts } from "../core/workstream-state.ts";
import { buildWorkstreams, type Workstream, type WsOverride, type WsPull } from "../core/workstreams.ts";
import type { OpenPull, OpenPullsListing } from "../github/queries/open-pulls.ts";
import { getMeta } from "../store/meta.ts";
import { ensureSubjects, markDirty, storedPulls } from "../store/subjects.ts";
import {
  getWorkstreamStates,
  listOverrides,
  memberFacts,
  previousWorkstreams,
  updateOverride,
  writeWorkstreams,
} from "../store/workstreams.ts";
import type { JobContext } from "./scheduler.ts";

export function toWsPull(repo: string, p: OpenPull): WsPull {
  return {
    repo,
    number: p.number,
    title: p.title,
    author: p.author ?? "",
    ...(p.authorType ? { authorType: p.authorType } : {}),
    headRef: p.headRef,
    baseRef: p.baseRef,
    isDraft: p.isDraft,
    updatedAt: p.updatedAt,
  };
}

function parseJson<T>(text: string | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function readListing(db: Database, repo: string): OpenPullsListing | null {
  return parseJson<OpenPullsListing>(getMeta(db, openPullsMetaKey(repo)));
}

export function readRecentlyClosed(db: Database, repo: string): ClosedPull[] {
  const parsed = parseJson<ClosedPull[]>(getMeta(db, recentlyClosedMetaKey(repo)));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * The core skips a merge override when one of its keys is not in the pull set, which happens
 * once that PR drops off the recently-closed list. Move the anchor to another PR of the stack
 * the key was in (open PRs first, then the highest number), and
 * store the new anchor so later rebuilds keep it.
 */
function reanchorMergeOverrides(
  db: Database,
  repo: string,
  pulls: readonly WsPull[],
  previous: readonly Workstream[],
): WsOverride[] {
  const inPulls = new Map(pulls.map((p) => [`${repo}#${p.number}`, p]));
  const anchorFor = (key: SubjectKey): SubjectKey => {
    if (inPulls.has(key)) return key;
    // Only the key's own stack: the merged workstream also holds the other side's members.
    const ws = previous.find((w) => w.members.includes(key));
    const stack = new Set([key]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of ws?.edges ?? []) {
        if (stack.has(e.child) !== stack.has(e.parent)) {
          stack.add(e.child).add(e.parent);
          grew = true;
        }
      }
    }
    const candidates = [...stack].filter((k) => inPulls.has(k));
    const rank = (k: SubjectKey) => (inPulls.get(k)?.closed ? 0 : 1);
    const best = candidates.toSorted(
      (a, b) => rank(b) - rank(a) || (inPulls.get(b)?.number ?? 0) - (inPulls.get(a)?.number ?? 0),
    )[0];
    return best ?? key;
  };

  return listOverrides(db, repo).map(({ id, override }) => {
    if (override.kind !== "merge") return override;
    const keys: [SubjectKey, SubjectKey] = [anchorFor(override.keys[0]), anchorFor(override.keys[1])];
    if (keys[0] === override.keys[0] && keys[1] === override.keys[1]) return override;
    const moved: WsOverride = { kind: "merge", keys };
    updateOverride(db, id, moved);
    return moved;
  });
}

/** Asks the rebuild to give `id` to the workstream holding any of `keys`. */
export interface WorkstreamIdHint {
  keys: readonly SubjectKey[];
  id: string;
}

/**
 * The core pairs IDs by member overlap and cannot tell which side of a manual merge should
 * keep its ID. Each merge keeps the ID of its target (the workstream that held `keys[0]`),
 * newest merge first. Hints that would take an ID from a group an earlier hint already
 * placed are skipped; otherwise the two groups swap IDs.
 */
function claimIds(workstreams: Workstream[], hints: readonly WorkstreamIdHint[]): void {
  const claimed = new Set<Workstream>();
  for (const hint of hints) {
    const group = workstreams.find((w) => hint.keys.some((k) => w.members.includes(k)));
    if (!group || claimed.has(group)) continue;
    const holder = workstreams.find((w) => w.id === hint.id);
    if (holder && holder !== group) {
      if (claimed.has(holder)) continue;
      holder.id = group.id;
    }
    group.id = hint.id;
    claimed.add(group);
  }
}

function mergeHints(overrides: readonly WsOverride[], previous: readonly Workstream[]): WorkstreamIdHint[] {
  return overrides
    .flatMap((o) => {
      if (o.kind !== "merge") return [];
      const target = previous.find((w) => w.members.includes(o.keys[0]));
      return target ? [{ keys: [o.keys[0]], id: target.id }] : [];
    })
    .reverse();
}

export interface RebuildResult {
  workstreams: Workstream[];
  shownIds: string[];
  /** Subjects created (origin `stack`) for members of shown workstreams. */
  addedKeys: SubjectKey[];
  changedKeys: SubjectKey[];
  changedIds: string[];
}

/**
 * Rebuilds the workstreams of `repo` from the stored open-PR listing, the recently-closed list
 * and the manual overrides. Members of shown workstreams become subjects (origin `stack`,
 * dirty at priority 0); other members stay listing-only. No API calls. Returns null when there
 * is no listing yet. `idHints` (from undoing a merge) win over the merge overrides' own IDs.
 */
export function rebuildWorkstreams(
  db: Database,
  config: Config,
  repo: string,
  now: Date,
  idHints: readonly WorkstreamIdHint[] = [],
): RebuildResult | null {
  const listing = readListing(db, repo);
  if (!listing) return null;
  const nowIso = now.toISOString();
  const rc = repoConfig(config, repo);
  const open = listing.pulls.map((p) => toWsPull(repo, p));
  const since = new Date(now.getTime() - RECENTLY_CLOSED_MS).toISOString();
  const pulls = groupingPulls({
    open,
    listedAt: listing.fetchedAt,
    recentlyClosed: readRecentlyClosed(db, repo),
    stored: storedPulls(db, repo, since),
    now,
  });

  const previous = previousWorkstreams(db, repo);
  const overrides = reanchorMergeOverrides(db, repo, pulls, previous);
  const workstreams = buildWorkstreams(pulls, {
    trunks: rc.trunks,
    overrides,
    previous,
    config: rc.workstreams,
    now,
  });
  claimIds(workstreams, [...idHints, ...mergeHints(overrides, previous)]);

  const allMembers = workstreams.flatMap((w) => w.members);
  const stored = memberFacts(db, allMembers);
  const facts = new Map<SubjectKey, MemberFacts>(stored);
  const authorOf = new Map(pulls.map((p) => [`${repo}#${p.number}`, p.author]));
  for (const key of allMembers) {
    if (facts.has(key)) continue;
    facts.set(key, {
      author: authorOf.get(key) || null,
      requestedReviewers: [],
      reviewers: [],
      commenters: [],
      threadSection: null,
    });
  }

  const me = config.me ?? getMeta(db, META.viewerLogin) ?? null;
  const states = getWorkstreamStates(
    db,
    workstreams.map((w) => w.id),
  );
  const shown = workstreams.filter((w) => isShownWorkstream(w, facts, me, states.get(w.id)?.seenAt ?? null));

  const numberOf = new Map(pulls.map((p) => [`${repo}#${p.number}`, p.number]));
  const addedKeys = shown
    .flatMap((w) => w.members)
    .filter((key) => !stored.has(key))
    .sort();
  ensureSubjects(
    db,
    shown.flatMap((w) =>
      w.members.map((key) => ({
        subjectKey: key,
        repo,
        number: numberOf.get(key) ?? 0,
        kind: "pr" as const,
        origin: "stack" as const,
      })),
    ),
  );
  if (addedKeys.length > 0) markDirty(db, addedKeys, nowIso, 0);

  const withSubject = new Set([...stored.keys(), ...addedKeys]);
  const listingOnly = new Set(allMembers.filter((key) => !withSubject.has(key)));
  const { changedKeys, changedIds } = writeWorkstreams(db, repo, workstreams, listingOnly, nowIso);
  return { workstreams, shownIds: shown.map((w) => w.id), addedKeys, changedKeys, changedIds };
}

/** Rebuilds the workstreams of `repo` and logs the outcome. */
export function rebuildAndLog(
  ctx: Pick<JobContext, "db" | "config" | "clock" | "log">,
  repo: string,
): RebuildResult | null {
  const result = rebuildWorkstreams(ctx.db, ctx.config, repo, ctx.clock());
  if (result) {
    ctx.log.info(
      `workstreams ${repo}: ${result.workstreams.length} (${result.shownIds.length} shown), ` +
        `${result.addedKeys.length} new subjects, ${result.changedKeys.length} membership changes`,
    );
  }
  return result;
}
