// Run v1b + truth on every force-push of a repo. Usage: REBASE_REPO=owner/name bun spikes/rebase/repo-check.ts
import { writeFileSync } from "node:fs";
import { variant1 } from "./detect.ts";
import { REPO, TRUNK } from "./git.ts";
import { stats } from "./github.ts";
import { loadPushes } from "./load.ts";
import { truth } from "./truth.ts";

const pushes = loadPushes();
console.log({ repo: REPO, trunk: TRUNK, pushes: pushes.length });

const coarse = (v: string) => (v === "noop" ? "rebase_only" : v);
const rows = [];
for (const p of pushes) {
  let v1b = (await variant1({ ...p, baseBefore: p.baseBefore2, baseAfter: p.baseAfter2 })).res;
  if (v1b.verdict === "unknown" && v1b.reason.includes("404")) {
    const fix = (b: string) => (/^[0-9a-f]{40}$/.test(b) ? b : TRUNK);
    const retry = (await variant1({ ...p, baseBefore: fix(p.baseBefore2), baseAfter: fix(p.baseAfter2) })).res;
    v1b = { ...retry, reason: `ref 404 -> ${TRUNK}: ${retry.reason}`, calls: retry.calls + v1b.calls };
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
    stacked: p.stacked,
    src2: p.baseSource2,
    bases: `${p.baseBefore2.slice(0, 12)}/${p.baseAfter2.slice(0, 12)}`,
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
  console.log(
    [row.n, row.at.slice(5, 16), row.actor, row.src2, row.bases, `v1b=${row.v1b}`, `(${row.v1bReason})`, `truth=${row.truth}`, row.truthReason, row.own, `${row.truthMs}ms`, row.agree ? "" : "DISAGREE"].join(" "),
  );
}
writeFileSync(`/tmp/opencode/rebase/${REPO.split("/")[1]}-check.json`, JSON.stringify(rows, null, 2));
const known = rows.filter((r) => r.truth !== "unknown");
const count = (f: (r: (typeof rows)[number]) => string) => {
  const m: Record<string, number> = {};
  for (const r of rows) m[f(r)] = (m[f(r)] ?? 0) + 1;
  return m;
};
console.log({
  total: rows.length,
  known: known.length,
  agree: known.filter((r) => r.agree).length,
  v1b: count((r) => r.v1b),
  truth: count((r) => r.truth),
  calls: rows.reduce((s, r) => s + r.calls, 0),
  stats,
});
