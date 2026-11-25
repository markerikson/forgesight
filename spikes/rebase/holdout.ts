import { writeFileSync } from "node:fs";
import { sample, variant1 } from "./detect.ts";
import { stats } from "./github.ts";
import { loadPushes, type Push } from "./load.ts";
import { truth } from "./truth.ts";

function pick<T>(xs: T[], n: number, seed: number): T[] {
  let s = seed * 7919 + 17;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return [...xs].sort(() => rnd() - 0.5).slice(0, n);
}

const used = new Set(sample().map((p) => p.id));
const all = loadPushes().filter((p) => p.at >= "2026-11-10" && !used.has(p.id));
const trunk = all.filter((p) => !p.stacked && p.baseSource2 === "ref");
const stackedRef = all.filter((p) => p.stacked && p.baseSource2 === "ref");
const nearest = all.filter((p) => p.baseSource2 === "base-nearest");
const others = all.filter((p) => !p.stacked && p.actor !== "Domiii");
const picked = new Map<string, Push>();
for (const p of [...pick(others, 8, 11), ...pick(trunk, 6, 12), ...pick(nearest, 22, 13), ...pick(stackedRef, 6, 14)]) picked.set(p.id, p);
const pushes = [...picked.values()];
console.log({ pool: all.length, trunk: trunk.length, stackedRef: stackedRef.length, nearest: nearest.length, picked: pushes.length });

const coarse = (v: string) => (v === "noop" ? "rebase_only" : v);
const rows = [];
for (const p of pushes) {
  let v1b = (await variant1({ ...p, baseBefore: p.baseBefore2, baseAfter: p.baseAfter2 })).res;
  if (v1b.verdict === "unknown" && v1b.reason.includes("404")) {
    // Deleted base refs (merged parents): fall back to master, as production would after a parent merge.
    const fix = (b: string) => (/^[0-9a-f]{40}$/.test(b) ? b : "master");
    const retry = (await variant1({ ...p, baseBefore: fix(p.baseBefore2), baseAfter: fix(p.baseAfter2) })).res;
    v1b = { ...retry, reason: `ref 404 -> master: ${retry.reason}`, calls: retry.calls + v1b.calls };
  }
  let t;
  try {
    t = await truth(p);
  } catch (e) {
    t = { verdict: "unknown", reason: String(e).slice(0, 200), sameContent: false, ms: 0, before: { commits: [] }, after: { commits: [] } };
  }
  const row = {
    n: p.number,
    at: p.at,
    actor: p.actor,
    src2: p.baseSource2,
    v1b: v1b.verdict,
    v1bReason: v1b.reason,
    calls: v1b.calls,
    truth: t.verdict,
    truthReason: t.reason,
    own: `${t.before.commits.length}/${t.after.commits.length}`,
    truthMs: Math.round(t.ms),
    agree: coarse(v1b.verdict) === coarse(t.verdict),
    push: p,
  };
  rows.push(row);
  console.log([row.n, row.at.slice(5, 16), row.actor, row.src2, `v1b=${row.v1b}`, `truth=${row.truth}`, row.truthReason, row.own, `${row.truthMs}ms`, row.agree ? "" : "DISAGREE"].join(" "));
}
writeFileSync("/tmp/opencode/rebase/holdout.json", JSON.stringify(rows, null, 2));
const known = rows.filter((r) => r.truth !== "unknown");
console.log({ total: rows.length, known: known.length, agree: known.filter((r) => r.agree).length, stats });
