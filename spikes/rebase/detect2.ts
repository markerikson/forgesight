import { writeFileSync } from "node:fs";
import { sample, variant1 } from "./detect.ts";
import { stats } from "./github.ts";
import { truth } from "./truth.ts";

const pushes = sample();
const rows = [];
for (const p of pushes) {
  const v1 = (await variant1(p)).res;
  const v1b = (await variant1({ ...p, baseBefore: p.baseBefore2, baseAfter: p.baseAfter2 })).res;
  let t;
  try {
    t = await truth(p);
  } catch (e) {
    t = { verdict: "unknown", reason: String(e).slice(0, 200), sameContent: false, ms: 0, before: { commits: [] }, after: { commits: [] } };
  }
  const coarse = (v: string) => (v === "noop" ? "rebase_only" : v);
  const row = {
    n: p.number,
    at: p.at,
    actor: p.actor,
    src: p.baseSource,
    src2: p.baseSource2,
    v1: v1.verdict,
    v1b: v1b.verdict,
    v1bReason: v1b.reason,
    truth: t.verdict,
    truthReason: t.reason,
    sameContent: t.sameContent,
    own: `${t.before.commits.length}/${t.after.commits.length}`,
    truthMs: Math.round(t.ms),
    agreeV1: coarse(v1.verdict) === coarse(t.verdict),
    agreeV1b: coarse(v1b.verdict) === coarse(t.verdict),
    push: p,
  };
  rows.push(row);
  console.log(
    [row.n, row.at.slice(5, 16), row.actor, row.src2, `v1=${row.v1}`, `v1b=${row.v1b}`, `truth=${row.truth}`, row.truthReason, row.own, `${row.truthMs}ms`, row.agreeV1b ? "" : "DISAGREE"].join(" "),
  );
}
writeFileSync("/tmp/opencode/rebase/results2.json", JSON.stringify(rows, null, 2));
const known = rows.filter((r) => r.truth !== "unknown");
console.log({
  total: rows.length,
  known: known.length,
  agreeV1: known.filter((r) => r.agreeV1).length,
  agreeV1b: known.filter((r) => r.agreeV1b).length,
  stats,
});
