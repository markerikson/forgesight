import type { Database } from "bun:sqlite";
import type { Config } from "../core/config.ts";
import { repoConfig } from "../core/config.ts";
import { META, openPullsMetaKey, recentlyClosedMetaKey } from "../core/meta-keys.ts";
import type { ClosedPull } from "../core/recently-closed.ts";
import type { SubjectKey } from "../core/types.ts";
import { isShownWorkstream, type MemberFacts } from "../core/workstream-state.ts";
import { buildWorkstreams, type Workstream, type WsPull } from "../core/workstreams.ts";
import type { OpenPull, OpenPullsListing } from "../github/queries/open-pulls.ts";
import { getMeta } from "../store/meta.ts";
import { ensureSubjects, markDirty } from "../store/subjects.ts";
import {
  getWorkstreamStates,
  listOverrides,
  memberFacts,
  previousWorkstreams,
  writeWorkstreams,
} from "../store/workstreams.ts";

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
 * is no listing yet.
 */
export function rebuildWorkstreams(
  db: Database,
  config: Config,
  repo: string,
  now: Date,
): RebuildResult | null {
  const listing = readListing(db, repo);
  if (!listing) return null;
  const nowIso = now.toISOString();
  const rc = repoConfig(config, repo);
  const open = listing.pulls.map((p) => toWsPull(repo, p));
  const closed = readRecentlyClosed(db, repo).map((c): WsPull => Object.assign({}, c.pull, { closedAt: c.closedAt }));
  const pulls = [...open, ...closed.filter((c) => !open.some((p) => p.number === c.number))];

  const workstreams = buildWorkstreams(pulls, {
    trunks: rc.trunks,
    overrides: listOverrides(db, repo).map((o) => o.override),
    previous: previousWorkstreams(db, repo),
    config: rc.workstreams,
    now,
  });

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
