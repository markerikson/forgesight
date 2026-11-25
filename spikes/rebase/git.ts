import { $ } from "bun";
import { normalizePatch } from "./patch.ts";

export const REPO = process.env.REBASE_REPO ?? "replayio/backend";
export const TRUNK = process.env.REBASE_TRUNK ?? (REPO === "replayio/backend" ? "master" : "main");
export const GIT_DIR = `/tmp/opencode/rebase/${REPO.split("/")[1]}.git`;

const git = (...args: string[]) => $`git --git-dir=${GIT_DIR} ${args}`.quiet().nothrow();

export async function has(sha: string): Promise<boolean> {
  return (await git("cat-file", "-e", `${sha}^{commit}`)).exitCode === 0;
}

export async function ensure(shas: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const s of shas) if (/^[0-9a-f]{40}$/.test(s) && !(await has(s))) missing.push(s);
  if (missing.length) await git("fetch", "-q", "--filter=blob:none", "origin", ...missing);
  const still: string[] = [];
  for (const s of missing) if (!(await has(s))) still.push(s);
  return still;
}

export async function resolveBase(base: string, head: string): Promise<string | undefined> {
  const ref = /^[0-9a-f]{40}$/.test(base) ? base : `refs/heads/${base}`;
  const r = await git("merge-base", ref, head);
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}

export interface RangeDiff {
  verdict: "rebase_only" | "changed";
  pairs: { mark: string; left: string; right: string; subject: string }[];
  ms: number;
  raw: string;
}

export async function rangeDiff(baseBefore: string, before: string, baseAfter: string, after: string): Promise<RangeDiff> {
  const t0 = performance.now();
  const r = await git("range-diff", "--no-color", `${baseBefore}..${before}`, `${baseAfter}..${after}`);
  const raw = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`range-diff failed: ${r.stderr}`);
  const pairs: RangeDiff["pairs"] = [];
  for (const line of raw.split("\n")) {
    const m = /^\s*(?:\d+|-):\s+([0-9a-f]+|-+)\s+([=!<>])\s+(?:\d+|-):\s+([0-9a-f]+|-+)\s?(.*)$/.exec(line);
    if (m) pairs.push({ left: m[1], mark: m[2], right: m[3], subject: m[4] });
  }
  const verdict = pairs.length > 0 && pairs.every((p) => p.mark === "=") ? "rebase_only" : "changed";
  return { verdict, pairs, ms: performance.now() - t0, raw };
}

export async function cumulative(base: string, head: string): Promise<Map<string, string>> {
  const r = await git("diff", "--no-color", "--no-renames", `${base}..${head}`);
  const out = new Map<string, string>();
  let file = "";
  let lines: string[] = [];
  const flush = () => {
    if (file) out.set(file, normalizePatch(lines.join("\n")));
  };
  for (const l of r.stdout.toString().split("\n")) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
    if (m) {
      flush();
      file = m[2];
      lines = [];
    } else lines.push(l);
  }
  flush();
  return out;
}

export async function commitCount(base: string, head: string): Promise<number> {
  const r = await git("rev-list", "--count", `${base}..${head}`);
  return Number(r.stdout.toString().trim());
}
