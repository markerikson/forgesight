/**
 * Records a pipeline fixture: `bun run fixture:record owner/repo#N [--name case-name]`.
 * Fetches the subject's whole timeline through the worker's enrichment path and writes
 * `src/core/__fixtures__/<case>/input/`:
 * - `graphql-NN.json`: each SubjectBatch query, its variables and the raw result
 * - `enrichment.json`: the parsed result the worker would store
 * - `threads.json`: notification threads for the subject from the worker's database, if any
 * - `case.json`: subject key, kind, repo mode and recording time
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.ts";
import { configPath } from "../src/config/paths.ts";
import { repoConfig } from "../src/core/config.ts";
import { initialBatchState, stickyMarkers } from "../src/core/enrich-plan.ts";
import type { ThreadRecord } from "../src/core/types.ts";
import { Governor, MemoryApiCallLog } from "../src/github/budget.ts";
import { createGitHubClient } from "../src/github/client.ts";
import { resolveToken } from "../src/github/token.ts";
import type { GqlOpts, GqlResult } from "../src/github/types.ts";
import { defaultDbPath, openDb } from "../src/store/db.ts";
import { threadsForSubject } from "../src/store/threads.ts";
import { enrichRepoBatch } from "../src/worker/enrich-batch.ts";

export interface FixtureArgs {
  owner: string;
  repo: string;
  number: number;
  name: string;
}

const usage = "Usage: bun run fixture:record owner/repo#N [--name case-name]";

export function parseFixtureArgs(argv: string[]): FixtureArgs {
  let target: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") {
      name = argv[++i];
      if (!name) throw new Error(`--name needs a value\n${usage}`);
    } else if (arg?.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (target === undefined && arg !== undefined) {
      target = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n${usage}`);
    }
  }
  const match = target?.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!match) throw new Error(usage);
  const [, owner = "", repo = "", num = ""] = match;
  const number = Number(num);
  const caseName = name ?? `${repo}-${number}`;
  if (!/^[\w.-]+$/.test(caseName)) {
    throw new Error(`Case name may only use letters, digits, '.', '_' and '-': ${caseName}`);
  }
  return { owner, repo, number, name: caseName };
}

interface RecordedCall {
  query: string;
  variables: Record<string, unknown>;
  opts: GqlOpts;
  result: GqlResult<unknown>;
}

/** Threads for the subject from the worker's database, if there is one. */
function storedThreads(subjectKey: string): ThreadRecord[] {
  const path = defaultDbPath();
  if (!existsSync(path)) return [];
  const db = openDb(path, { readonly: true });
  try {
    return threadsForSubject(db, subjectKey);
  } finally {
    db.close();
  }
}

async function record(args: FixtureArgs): Promise<void> {
  const repo = `${args.owner}/${args.repo}`;
  const subjectKey = `${repo}#${args.number}`;
  const { config, error } = await loadConfig(configPath());
  if (error) console.warn(`Config error, using defaults: ${error}`);
  const clock = () => new Date();
  const governor = new Governor(new MemoryApiCallLog(), config.budget, clock);
  const gh = createGitHubClient(config, resolveToken(), { governor, clock });
  const calls: RecordedCall[] = [];
  const graphql = async <T>(query: string, variables: Record<string, unknown>, opts: GqlOpts): Promise<GqlResult<T>> => {
    const result = await gh.graphql<T>(query, variables, opts);
    calls.push({ query, variables, opts, result });
    return result;
  };
  const mode = repoConfig(config, repo).mode;

  // The notification URL is not always at hand, so try a pull request first and fall back to an issue.
  for (const kind of ["pr", "issue"] as const) {
    calls.length = 0;
    // oxlint-disable-next-line no-await-in-loop -- the issue attempt only runs if the PR one finds nothing
    const out = await enrichRepoBatch(
      { graphql, clock },
      {
        repo,
        mode,
        subjects: [{ subjectKey, kind, number: args.number, since: null }],
        stickyIds: new Map(),
        state: initialBatchState(1),
        maxSize: 1,
        markers: stickyMarkers(config),
        workClass: "enrich",
      },
    );
    const outcome = out.outcomes[0];
    if (outcome?.kind === "notFound") continue;
    if (outcome?.kind !== "ok") throw new Error(`Fetching ${subjectKey} failed: ${outcome?.error ?? "no outcome"}`);

    const dir = join(import.meta.dir, "..", "src", "core", "__fixtures__", args.name, "input");
    mkdirSync(dir, { recursive: true });
    const write = (file: string, value: unknown) => writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
    calls.forEach((call, i) => write(`graphql-${String(i + 1).padStart(2, "0")}.json`, call));
    write("enrichment.json", outcome.result);
    const threads = storedThreads(subjectKey);
    write("threads.json", threads);
    write("case.json", { subjectKey, kind, mode, recordedAt: clock().toISOString() });
    console.log(
      `${subjectKey} (${kind}, ${mode}): ${calls.length} queries, ${out.cost} pts, ` +
        `${outcome.result.timelineItems.length} timeline items, ${outcome.result.stickies.length} stickies, ` +
        `${threads.length} stored threads -> ${dir}`,
    );
    return;
  }
  throw new Error(`${subjectKey} is not a pull request or issue`);
}

if (import.meta.main) {
  try {
    await record(parseFixtureArgs(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
