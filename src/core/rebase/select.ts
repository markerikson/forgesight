import { type Config, repoConfig } from "../config.ts";
import type { SubjectRecord, TimelineItemRecord } from "../types.ts";

/** A force-push to the PR's head branch. */
export interface HeadPush {
  id: string;
  at: string;
  before: string;
  after: string;
}

/** A force-push to the PR's base branch, recorded on the PR timeline. */
export interface BasePush {
  at: string;
  before: string;
  after: string;
}

/** The PR's base branch changed away from `from`. */
export interface RefChange {
  at: string;
  from: string | null;
}

export interface PushHistory {
  heads: HeadPush[];
  baseForces: BasePush[];
  refChanges: RefChange[];
}

export type BaseSource = "basePush" | "ref" | "nextBasePush";

export interface PushBases {
  before: string;
  after: string;
  source: { before: BaseSource; after: BaseSource };
}

/** A base push this close to a head push is the same restack. */
const SAME_RESTACK_MS = 15_000;

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function oid(value: unknown): string | null {
  return str(obj(value)?.oid);
}

/** Rebase checks run on open PRs in overview repos while rebase detection is enabled. */
export function needsVerdict(subject: Pick<SubjectRecord, "kind" | "state" | "repo">, config: Config): boolean {
  return (
    config.rebase.enabled &&
    subject.kind === "pr" &&
    subject.state === "OPEN" &&
    repoConfig(config, subject.repo).view === "overview"
  );
}

/** Pulls the pushes and base changes out of a PR timeline, oldest first. */
export function pushHistory(items: TimelineItemRecord[]): PushHistory {
  const history: PushHistory = { heads: [], baseForces: [], refChanges: [] };
  const sorted = [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const item of sorted) {
    const raw = obj(item.raw) ?? {};
    switch (item.typename) {
      case "HeadRefForcePushedEvent":
      case "BaseRefForcePushedEvent": {
        const before = oid(raw.beforeCommit);
        const after = oid(raw.afterCommit);
        if (!before || !after) break;
        if (item.typename === "HeadRefForcePushedEvent") {
          history.heads.push({ id: item.nodeId, at: item.createdAt, before, after });
        } else {
          history.baseForces.push({ at: item.createdAt, before, after });
        }
        break;
      }
      case "BaseRefChangedEvent":
        history.refChanges.push({ at: item.createdAt, from: str(raw.previousRefName) });
        break;
      case "AutomaticBaseChangeSucceededEvent":
        history.refChanges.push({ at: item.createdAt, from: str(raw.oldBase) });
        break;
    }
  }
  return history;
}

export interface BaseForPushInput extends PushHistory {
  push: HeadPush;
  /** The PR's current base branch name. */
  baseRef: string;
  trunks: string[];
  /**
   * Force-pushes to branches this PR was based on, taken from the timelines of the PRs whose head
   * they are, keyed by branch name.
   */
  branchPushes?: ReadonlyMap<string, BasePush[]>;
}

/**
 * Picks the base to diff each side of a head push against: the base commit the head sat on before
 * and after the push. Each side uses the base branch set at its time. Force-pushes to that branch,
 * from this PR's timeline or the parent PR's, show where a stacked parent moved; a trunk base, or a
 * parent that did not move since, is diffed against by name.
 */
export function baseForPush(input: BaseForPushInput): PushBases {
  const { heads, baseForces, refChanges, push, baseRef, trunks, branchPushes } = input;
  const pushAt = Date.parse(push.at);
  const refAfter = (t: number) => refChanges.find((c) => Date.parse(c.at) > t)?.from ?? baseRef;
  // Retargeting a PR right after pushing it is one step: the push already sits on the new base.
  const headRefAt = (t: number) => refAfter(t + SAME_RESTACK_MS);

  const ownPushes = new Map<string, BasePush[]>();
  for (const b of baseForces) {
    const ref = refAfter(Date.parse(b.at));
    ownPushes.set(ref, [...(ownPushes.get(ref) ?? []), b]);
  }
  const pushesTo = (ref: string): BasePush[] =>
    [...(ownPushes.get(ref) ?? []), ...(branchPushes?.get(ref) ?? [])].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at),
    );

  const previous =
    heads.find((h) => h.after === push.before && Date.parse(h.at) < pushAt) ??
    heads.filter((h) => Date.parse(h.at) < pushAt).at(-1);
  const beforeAt = previous ? Date.parse(previous.at) : null;

  const side = (t: number | null): { sha: string; source: BaseSource } => {
    // With no earlier head push, the old head is only known to predate this push. A base change
    // just before the push belongs to it, so the old head sat on the base set before that.
    const ref = t === null ? refAfter(pushAt - SAME_RESTACK_MS) : headRefAt(t);
    const pushes = pushesTo(ref);
    if (t !== null) {
      let nearest: BasePush | undefined;
      let best = Infinity;
      for (const b of pushes) {
        const d = Math.abs(Date.parse(b.at) - t);
        if (d <= SAME_RESTACK_MS && d < best) {
          nearest = b;
          best = d;
        }
      }
      if (nearest) return { sha: nearest.after, source: "basePush" };
    }
    if (trunks.includes(ref)) return { sha: ref, source: "ref" };
    // Base pushes recorded on this PR came after its old head existed; the parent PR's pushes only
    // count from just before this push.
    const next =
      t === null
        ? pushes.find((b) => ownPushes.get(ref)?.includes(b) || Date.parse(b.at) > pushAt - SAME_RESTACK_MS)
        : pushes.find((b) => Date.parse(b.at) > t);
    if (next) return { sha: next.before, source: "nextBasePush" };
    return { sha: ref, source: "ref" };
  };

  const before = side(beforeAt);
  const after = side(pushAt);
  return { before: before.sha, after: after.sha, source: { before: before.source, after: after.source } };
}
