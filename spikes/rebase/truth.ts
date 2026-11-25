import { $ } from "bun";
import { GIT_DIR, TRUNK, ensure } from "./git.ts";
import { normalizePatch } from "./patch.ts";
import type { Push } from "./load.ts";

const git = (...args: string[]) => $`git --git-dir=${GIT_DIR} ${args}`.quiet().nothrow();

export interface Own {
  commits: string[];
  patchIds: string[];
  parent: string;
}

export interface Truth {
  verdict: "rebase_only" | "noop" | "changed" | "unknown";
  sameContent: boolean;
  before: Own;
  after: Own;
  reason: string;
  ms: number;
}

async function refExists(ref: string): Promise<boolean> {
  return (await git("rev-parse", "-q", "--verify", ref)).exitCode === 0;
}

async function exclusions(p: Push): Promise<string[]> {
  const master = (await git("rev-list", "-1", "--first-parent", `--before=${p.at}`, `refs/heads/${TRUNK}`)).stdout.toString().trim();
  const ex = [master, ...p.baseShas];
  if (p.stacked && p.baseShas.length === 0 && (await refExists(`refs/heads/${p.baseRef}`))) ex.push(`refs/heads/${p.baseRef}`);
  return ex;
}

async function own(tip: string, ex: string[]): Promise<Own> {
  const r = await git("rev-list", "--reverse", "--no-merges", tip, "--not", ...ex);
  const commits = r.stdout.toString().split("\n").filter(Boolean);
  if (commits.length === 0 || commits.length > 300) return { commits, patchIds: [], parent: "" };
  const parent = (await git("rev-parse", `${commits[0]}^`)).stdout.toString().trim();
  const ids = new Map<string, string>();
  const log = await $`git --git-dir=${GIT_DIR} show --no-color -p --format=commit%x20%H ${commits} | git patch-id --stable`
    .quiet()
    .nothrow();
  for (const line of log.stdout.toString().split("\n")) {
    const [pid, sha] = line.split(" ");
    if (pid && sha) ids.set(sha, pid);
  }
  return { commits, patchIds: commits.map((c) => ids.get(c) ?? `empty:${c}`), parent };
}

async function ownDiff(o: Own, tip: string): Promise<string> {
  const r = await git("diff", "--no-color", "--no-renames", `${o.parent}..${tip}`);
  return normalizePatch(r.stdout.toString());
}

export async function truth(p: Push): Promise<Truth> {
  const t0 = performance.now();
  const missing = await ensure([p.before, p.after, ...p.baseShas]);
  const ex = (await exclusions(p)).filter((x) => !missing.includes(x));
  const before = await own(p.before, ex);
  const after = await own(p.after, ex);
  const done = (verdict: Truth["verdict"], reason: string, sameContent = false): Truth => ({
    verdict,
    sameContent,
    before,
    after,
    reason,
    ms: performance.now() - t0,
  });
  if (missing.includes(p.before) || missing.includes(p.after)) return done("unknown", "sha missing");
  if (!before.patchIds.length || !after.patchIds.length)
    return done("unknown", `own commits ${before.commits.length}/${after.commits.length}`);
  const sameContent = (await ownDiff(before, p.before)) === (await ownDiff(after, p.after));
  if (before.patchIds.join() === after.patchIds.join())
    return done(before.parent === after.parent ? "noop" : "rebase_only", "patch-ids equal", sameContent);
  if (sameContent) return done("rebase_only", "same content, different commits", true);
  return done("changed", "patch-ids differ", false);
}
