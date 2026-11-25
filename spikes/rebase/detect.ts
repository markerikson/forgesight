import { writeFileSync } from "node:fs";
import { loadPushes, type Push } from "./load.ts";
import { get, stats, type Compare, type CommitDetail, type CompareCommit } from "./github.ts";
import { compareSides, fileSigs } from "./patch.ts";
import * as G from "./git.ts";

const REPO = `repos/${G.REPO}`;

type Verdict = "rebase_only" | "noop" | "changed" | "unknown";

interface Result {
  push: Push;
  v1: { verdict: Verdict; calls: number; ms: number; reason: string; differing: string[]; truncated: boolean; noPatch: number; mergeBaseSame: boolean };
  v2: { verdict: Verdict; calls: number; reason: string };
  rd: { verdict: Verdict; ms: number; pairs: string; reason: string };
  gitCum: { verdict: Verdict; differing: string[] };
  fetchMs: number;
}

function pick<T>(xs: T[], n: number, seed: number): T[] {
  const a = [...xs];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export function sample(): Push[] {
  const all = loadPushes().filter((p) => p.at >= "2026-11-17");
  const trunkOther = all.filter((p) => !p.stacked && p.actor !== "Domiii");
  const trunkDom = all.filter((p) => !p.stacked && p.actor === "Domiii");
  const bfp = all.filter((p) => p.baseSource === "base-force-push");
  const tip = all.filter((p) => p.baseSource === "base-tip");
  const sref = all.filter((p) => p.stacked && p.baseSource === "ref");
  return [
    ...pick(trunkOther, 10, 1),
    ...pick(trunkDom, 8, 2),
    ...pick(bfp, 14, 3),
    ...pick(tip, 8, 4),
    ...pick(sref, 6, 5),
  ];
}

const ownKey = (c: CompareCommit) => `${c.commit.author.date}|${c.commit.message.split("\n")[0]}`;

export async function variant1(p: Push) {
  const t0 = performance.now();
  const before = await get<Compare>(`${REPO}/compare/${p.baseBefore}...${p.before}`);
  const after = await get<Compare>(`${REPO}/compare/${p.baseAfter}...${p.after}`);
  const calls = 2;
  const ms = before.ms + after.ms;
  void t0;
  if (!before.ok || !after.ok) {
    return {
      res: { verdict: "unknown" as Verdict, calls, ms, reason: `compare ${before.ok ? "" : `before:${before.status}`} ${after.ok ? "" : `after:${after.status}`}`.trim(), differing: [], truncated: false, noPatch: 0, mergeBaseSame: false },
      before: undefined,
      after: undefined,
    };
  }
  const b = before.body;
  const a = after.body;
  const truncated = (b.files?.length ?? 0) >= 300 || (a.files?.length ?? 0) >= 300 || b.total_commits > 250 || a.total_commits > 250;
  const d = compareSides(b.files ?? [], a.files ?? []);
  const mergeBaseSame = b.merge_base_commit.sha === a.merge_base_commit.sha;
  let verdict: Verdict = d.sameFiles ? (mergeBaseSame ? "noop" : "rebase_only") : "changed";
  let reason = d.sameFiles ? "patches equal" : `${d.differing.length} files differ`;
  if (truncated) {
    verdict = "changed";
    reason = "truncated (fail open)";
  }
  return {
    res: { verdict, calls, ms, reason, differing: d.differing, truncated, noPatch: d.noPatch.length, mergeBaseSame },
    before: b,
    after: a,
  };
}

async function variant2(b: Compare | undefined, a: Compare | undefined) {
  if (!b || !a) return { verdict: "unknown" as Verdict, calls: 2, reason: "compare failed" };
  const left = new Map(b.commits.map((c) => [ownKey(c), c]));
  const right = new Map(a.commits.map((c) => [ownKey(c), c]));
  const unmatched = [...left.keys()].filter((k) => !right.has(k)).length + [...right.keys()].filter((k) => !left.has(k)).length;
  if (unmatched > 0) return { verdict: "changed" as Verdict, calls: 2, reason: `${unmatched} unmatched commits` };
  let calls = 2;
  let differ = 0;
  for (const [k, lc] of left) {
    const rc = right.get(k)!;
    if (lc.sha === rc.sha) continue;
    const x = await get<CommitDetail>(`${REPO}/commits/${lc.sha}`);
    const y = await get<CommitDetail>(`${REPO}/commits/${rc.sha}`);
    calls += 2;
    if (!x.ok || !y.ok) return { verdict: "unknown" as Verdict, calls, reason: "commit fetch failed" };
    const sx = fileSigs(x.body.files ?? []);
    const sy = fileSigs(y.body.files ?? []);
    const same = sx.size === sy.size && [...sx].every(([f, s]) => sy.get(f)?.sig === s.sig);
    if (!same) differ++;
  }
  const same = b.commits.length > 0 && differ === 0;
  const mbSame = b.merge_base_commit.sha === a.merge_base_commit.sha;
  return {
    verdict: (same ? (mbSame ? "noop" : "rebase_only") : "changed") as Verdict,
    calls,
    reason: differ ? `${differ} commit patches differ` : `${left.size} commits matched`,
  };
}

async function groundTruth(p: Push) {
  const t0 = performance.now();
  const missing = await G.ensure([p.before, p.after, p.baseBefore, p.baseAfter]);
  const fetchMs = performance.now() - t0;
  const none = (reason: string) => ({
    rd: { verdict: "unknown" as Verdict, ms: 0, pairs: "", reason },
    gitCum: { verdict: "unknown" as Verdict, differing: [] },
    fetchMs,
  });
  if (missing.length) return none(`missing ${missing.map((s) => s.slice(0, 8)).join(",")}`);
  const mbB = await G.resolveBase(p.baseBefore, p.before);
  const mbA = await G.resolveBase(p.baseAfter, p.after);
  if (!mbB || !mbA) return none("no merge base / ref gone");
  const rd = await G.rangeDiff(mbB, p.before, mbA, p.after);
  const cb = await G.cumulative(mbB, p.before);
  const ca = await G.cumulative(mbA, p.after);
  const differing = [...new Set([...cb.keys(), ...ca.keys()])].filter((f) => cb.get(f) !== ca.get(f));
  const mbSame = mbB === mbA;
  const lift = (v: "rebase_only" | "changed"): Verdict => (v === "rebase_only" && mbSame ? "noop" : v);
  return {
    rd: {
      verdict: lift(rd.verdict),
      ms: rd.ms,
      pairs: rd.pairs.map((x) => x.mark).join(""),
      reason: rd.pairs.length === 0 ? "empty range-diff" : "",
    },
    gitCum: { verdict: lift(differing.length ? "changed" : "rebase_only"), differing },
    fetchMs,
  };
}

if (import.meta.main) {
  const pushes = sample();
  const results: Result[] = [];
  for (const p of pushes) {
    const v1 = await variant1(p);
    const v2 = await variant2(v1.before, v1.after);
    const gt = await groundTruth(p).catch((e: Error) => ({
      rd: { verdict: "unknown" as Verdict, ms: 0, pairs: "", reason: `error: ${e.message.split("\n")[0].slice(0, 120)}` },
      gitCum: { verdict: "unknown" as Verdict, differing: [] },
      fetchMs: 0,
    }));
    const r: Result = { push: p, v1: v1.res, v2, rd: gt.rd, gitCum: gt.gitCum, fetchMs: gt.fetchMs };
    results.push(r);
    console.log(
      [
        p.subjectKey.split("#")[1],
        p.actor.padEnd(12),
        p.baseSource.padEnd(15),
        `v1=${r.v1.verdict}`.padEnd(16),
        `v2=${r.v2.verdict}(${r.v2.calls})`.padEnd(20),
        `rd=${r.rd.verdict}[${r.rd.pairs}]`.padEnd(26),
        `cum=${r.gitCum.verdict}`.padEnd(18),
        `${Math.round(r.rd.ms)}ms`,
        r.v1.reason,
        r.rd.reason,
      ].join(" "),
    );
  }
  writeFileSync("/tmp/opencode/rebase/results.json", JSON.stringify(results, null, 1));
  console.log(stats);
}
