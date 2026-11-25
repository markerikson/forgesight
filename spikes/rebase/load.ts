import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { REPO } from "./git.ts";

export interface Push {
  id: string;
  subjectKey: string;
  number: number;
  author: string;
  actor: string;
  at: string;
  before: string;
  after: string;
  baseRef: string;
  stacked: boolean;
  baseBefore: string;
  baseAfter: string;
  baseSource: "ref" | "base-force-push" | "base-tip";
  inBurst: boolean;
  beforeAt: string;
  baseBefore2: string;
  baseAfter2: string;
  baseSource2: "ref" | "base-nearest";
  baseShas: string[];
}

const TOLERANCE_MS = 15_000;

interface Ev {
  nodeId: string;
  typename: string;
  at: string;
  raw: {
    actor?: { login?: string } | null;
    beforeCommit?: { oid: string } | null;
    afterCommit?: { oid: string } | null;
    previousRefName?: string;
    currentRefName?: string;
    oldBase?: string;
  };
}

const TYPES = [
  "HeadRefForcePushedEvent",
  "BaseRefForcePushedEvent",
  "BaseRefChangedEvent",
  "AutomaticBaseChangeSucceededEvent",
];

interface Source {
  subjects: { subject_key: string; number: number; author: string; base_ref: string }[];
  events: (key: string) => Ev[];
}

function dbSource(repo: string): Source {
  const db = new Database(`${import.meta.dir}/../../.data/inbox.db`, { readonly: true });
  const subjects = db
    .query<{ subject_key: string; number: number; author: string; base_ref: string }, [string]>(
      "select subject_key, number, author, base_ref from subjects where repo = ? and kind = 'pr'",
    )
    .all(repo);
  const evQuery = db.query<{ node_id: string; typename: string; created_at: string; raw_json: string }, [string]>(
    `select node_id, typename, created_at, raw_json from timeline_items
     where subject_key = ? and typename in (${TYPES.map((t) => `'${t}'`).join(",")})
     order by created_at, node_id`,
  );
  return {
    subjects,
    events: (key) =>
      evQuery.all(key).map((r) => ({ nodeId: r.node_id, typename: r.typename, at: r.created_at, raw: JSON.parse(r.raw_json) })),
  };
}

// Repos not in .data/inbox.db: read the file written by fetch-repo.ts.
function fileSource(repo: string): Source {
  const d = JSON.parse(readFileSync(`/tmp/opencode/rebase/${repo.split("/")[1]}-events.json`, "utf8"));
  type Row = { node_id: string; typename: string; created_at: string; raw: Ev["raw"] };
  return {
    subjects: d.subjects,
    events: (key) =>
      ((d.events[key] ?? []) as Row[])
        .map((r) => ({ nodeId: r.node_id, typename: r.typename, at: r.created_at, raw: r.raw }))
        .sort((a, b) => a.at.localeCompare(b.at) || a.nodeId.localeCompare(b.nodeId)),
  };
}

export function loadPushes(repo = REPO): Push[] {
  const src = repo === "replayio/backend" ? dbSource(repo) : fileSource(repo);
  const subjects = src.subjects;
  const out: Push[] = [];
  for (const s of subjects) {
    const evs = src.events(s.subject_key);
    const heads = evs.filter((e) => e.typename === "HeadRefForcePushedEvent");
    const refChanges = evs
      .filter((e) => e.typename === "BaseRefChangedEvent" || e.typename === "AutomaticBaseChangeSucceededEvent")
      .map((e) => ({ ...e, raw: { ...e.raw, previousRefName: e.raw.previousRefName ?? e.raw.oldBase } }));
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      const before = h.raw.beforeCommit?.oid;
      const after = h.raw.afterCommit?.oid;
      if (!before || !after) continue;
      let baseRef = s.base_ref;
      for (const rc of refChanges) {
        if (rc.typename === "BaseRefChangedEvent" && rc.at > h.at && rc.raw.previousRefName) {
          baseRef = rc.raw.previousRefName;
          break;
        }
      }
      const stacked = baseRef !== "master" && baseRef !== "main";
      const prevHead = [...heads.slice(0, i)].reverse().find((p) => p.raw.afterCommit?.oid === before) ?? heads[i - 1];
      const windowStart = prevHead?.at ?? "";
      const baseForces = evs.filter(
        (e) => e.typename === "BaseRefForcePushedEvent" && e.at > windowStart && e.at <= h.at && e.raw.beforeCommit && e.raw.afterCommit,
      );
      const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 5 * 60_000;
      const inBurst = heads.some((o) => o !== h && near(o.at, h.at));
      const allBaseForces = evs.filter(
        (e) => e.typename === "BaseRefForcePushedEvent" && e.raw.beforeCommit && e.raw.afterCommit,
      );
      const tipAt = (t: string): string | undefined => {
        const prior = allBaseForces.filter((e) => e.at <= t).at(-1);
        if (prior) return prior.raw.afterCommit!.oid;
        return allBaseForces.find((e) => e.at > t)?.raw.beforeCommit!.oid;
      };
      const refAt = (t: string): string => {
        for (const rc of refChanges) if (rc.at > t && rc.raw.previousRefName) return rc.raw.previousRefName;
        return s.base_ref;
      };
      const baseAt = (t: string): { base: string; source: "ref" | "base-nearest" } => {
        const ref = refAt(h.at);
        const ms = Date.parse(t);
        const near = allBaseForces
          .map((e) => ({ e, d: Math.abs(Date.parse(e.at) - ms) }))
          .filter((x) => x.d <= TOLERANCE_MS)
          .sort((a, b) => a.d - b.d)[0];
        if (near) return { base: near.e.raw.afterCommit!.oid, source: "base-nearest" };
        if (ref === "master" || ref === "main" || allBaseForces.length === 0) return { base: ref, source: "ref" };
        const next = allBaseForces.find((e) => Date.parse(e.at) > ms);
        if (next) return { base: next.raw.beforeCommit!.oid, source: "base-nearest" };
        return { base: tipAt(t)!, source: "base-nearest" };
      };
      const beforeHead = [...heads.slice(0, i)].reverse().find((p) => p.raw.afterCommit?.oid === before);
      const beforeAt = beforeHead?.at ?? heads[i - 1]?.at ?? "";
      const sideB = baseAt(beforeAt);
      const sideA = baseAt(h.at);
      const extra = {
        beforeAt,
        baseBefore2: sideB.base,
        baseAfter2: sideA.base,
        baseSource2: sideB.source === "ref" && sideA.source === "ref" ? ("ref" as const) : ("base-nearest" as const),
        baseShas: [...new Set(allBaseForces.flatMap((e) => [e.raw.beforeCommit!.oid, e.raw.afterCommit!.oid]))],
      };
      if (stacked && baseForces.length === 0 && allBaseForces.length > 0) {
        const tip = tipAt(h.at)!;
        out.push({
          id: h.nodeId,
          subjectKey: s.subject_key,
          number: s.number,
          author: s.author,
          actor: h.raw.actor?.login ?? "",
          at: h.at,
          before,
          after,
          baseRef,
          stacked,
          baseBefore: tip,
          baseAfter: tip,
          baseSource: "base-tip",
          inBurst,
          ...extra,
        });
        continue;
      }
      if (stacked && baseForces.length > 0) {
        out.push({
          id: h.nodeId,
          subjectKey: s.subject_key,
          number: s.number,
          author: s.author,
          actor: h.raw.actor?.login ?? "",
          at: h.at,
          before,
          after,
          baseRef,
          stacked,
          baseBefore: baseForces[0].raw.beforeCommit!.oid,
          baseAfter: baseForces[baseForces.length - 1].raw.afterCommit!.oid,
          baseSource: "base-force-push",
          inBurst,
          ...extra,
        });
      } else {
        out.push({
          id: h.nodeId,
          subjectKey: s.subject_key,
          number: s.number,
          author: s.author,
          actor: h.raw.actor?.login ?? "",
          at: h.at,
          before,
          after,
          baseRef,
          stacked,
          baseBefore: baseRef,
          baseAfter: baseRef,
          baseSource: "ref",
          inBurst,
          ...extra,
        });
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

if (import.meta.main) {
  const pushes = loadPushes();
  const by = (f: (p: Push) => string) => {
    const m = new Map<string, number>();
    for (const p of pushes) m.set(f(p), (m.get(f(p)) ?? 0) + 1);
    return Object.fromEntries(m);
  };
  console.log({
    total: pushes.length,
    stacked: by((p) => String(p.stacked)),
    baseSource: by((p) => p.baseSource),
    actor: by((p) => p.actor),
    burst: by((p) => String(p.inBurst)),
    day: by((p) => p.at.slice(0, 10)),
  });
}
