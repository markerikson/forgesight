import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const CACHE = "/tmp/opencode/rebase/cache";
mkdirSync(CACHE, { recursive: true });

const token = (await Bun.$`gh auth token`.text()).trim();

export interface ApiStats {
  calls: number;
  cached: number;
  ms: number;
  notFound: number;
  serverErrors: number;
}

export const stats: ApiStats = { calls: 0, cached: 0, ms: 0, notFound: 0, serverErrors: 0 };

export interface CompareFile {
  filename: string;
  previous_filename?: string;
  status: string;
  sha: string | null;
  changes: number;
  patch?: string;
}

export interface CompareCommit {
  sha: string;
  commit: { message: string; author: { date: string; name: string } };
  parents: { sha: string }[];
}

export interface Compare {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  merge_base_commit: { sha: string };
  commits: CompareCommit[];
  files?: CompareFile[];
}

export interface CommitDetail {
  sha: string;
  files?: CompareFile[];
}

export type Got<T> = { ok: true; body: T; ms: number; cached: boolean } | { ok: false; status: number; ms: number; cached: boolean };

export async function get<T>(path: string): Promise<Got<T>> {
  const file = `${CACHE}/${path.replaceAll("/", "_")}.json`;
  if (existsSync(file)) {
    stats.cached++;
    const c = JSON.parse(readFileSync(file, "utf8")) as { status: number; body: T; ms: number };
    return c.status === 200 ? { ok: true, body: c.body, ms: c.ms, cached: true } : { ok: false, status: c.status, ms: c.ms, cached: true };
  }
  const t0 = performance.now();
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`https://api.github.com/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    stats.calls++;
    if (res.status < 500 || attempt >= 3) break;
    stats.serverErrors++;
    console.error(`  ${res.status} on ${path}, retry ${attempt + 1}: ${(await res.text()).slice(0, 120)}`);
    await Bun.sleep(5000 * (attempt + 1));
  }
  const body = res.status === 200 ? ((await res.json()) as T) : undefined;
  const ms = performance.now() - t0;
  stats.ms += ms;
  if (res.status === 404) stats.notFound++;
  if (res.status !== 200 && res.status !== 404 && res.status !== 422) {
    throw new Error(`${path}: ${res.status} ${await res.text()}`);
  }
  writeFileSync(file, JSON.stringify({ status: res.status, body, ms }));
  return body ? { ok: true, body, ms, cached: false } : { ok: false, status: res.status, ms, cached: false };
}
