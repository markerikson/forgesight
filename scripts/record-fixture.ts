/**
 * Records a pipeline fixture: `bun run fixture:record owner/repo#N [--name case-name]`.
 * Creates `src/core/__fixtures__/<case>/input/`. Fetching the GitHub calls that
 * fill the folder comes with the enrichment work.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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

if (import.meta.main) {
  try {
    const args = parseFixtureArgs(process.argv.slice(2));
    const dir = join(import.meta.dir, "..", "src", "core", "__fixtures__", args.name, "input");
    mkdirSync(dir, { recursive: true });
    console.log(`Created ${dir} for ${args.owner}/${args.repo}#${args.number}`);
    console.log("Recording GitHub responses is not implemented yet.");
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
