import { homedir } from "node:os";
import { join } from "node:path";

export interface DeploySettings {
  server: string;
  dir: string;
  envFile: string;
  configFile: string | null;
}

export const DEFAULT_DEPLOY_DIR = "/opt/forgesight";
export const DEFAULT_ENV_FILE = ".env.production";
export const REMOTE_CONFIG_DIR = ".config/forgesight";

export const RSYNC_FILTERS = [
  "--exclude=node_modules/",
  "--exclude=/.data/",
  "--exclude=/data/",
  "--exclude=.env*",
  "--exclude=/.deploy.env",
  "--exclude=.git/",
  "--exclude=/.codenomad/",
  "--exclude=/spikes/",
  "--include=/.timber/",
  "--include=/.timber/dist/***",
  "--exclude=/.timber/*",
];

// KEY=value lines, as in a dotenv file. No variable expansion; matching quotes are stripped.
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = match?.[1];
    const rest = match?.[2];
    if (key === undefined || rest === undefined) throw new Error(`can't parse line: ${raw}`);
    const quoted = /^(["'])(.*)\1$/.exec(rest);
    vars[key] = quoted ? (quoted[2] ?? "") : rest.replace(/\s+#.*$/, "");
  }
  return vars;
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

// Environment variables win over the file, so `DEPLOY_SERVER=other bun run deploy` works.
export function resolveSettings(
  fileVars: Record<string, string>,
  env: Record<string, string | undefined>,
  home: string,
): DeploySettings {
  const get = (key: string): string | null => {
    const value = env[key] || fileVars[key];
    return value ? expandHome(value, home) : null;
  };
  const server = get("DEPLOY_SERVER");
  if (!server) throw new Error("DEPLOY_SERVER is not set (put it in .deploy.env or the environment)");
  return {
    server,
    dir: get("DEPLOY_DIR") ?? DEFAULT_DEPLOY_DIR,
    envFile: get("DEPLOY_ENV_FILE") ?? DEFAULT_ENV_FILE,
    configFile: get("DEPLOY_CONFIG_FILE"),
  };
}

// Reads <root>/.deploy.env (optional, gitignored) plus the environment.
export async function loadSettings(root: string): Promise<DeploySettings> {
  const file = Bun.file(join(root, ".deploy.env"));
  const fileVars = (await file.exists()) ? parseEnvFile(await file.text()) : {};
  return resolveSettings(fileVars, process.env, homedir());
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ssh joins its arguments into one string for the remote shell, so the command is passed as a
// single pre-quoted argument. `bash -lc` loads the login profile so nvm-installed pm2 is on PATH.
export function remoteCommand(dir: string, command: string): string {
  return `bash -lc ${shellQuote(`cd ${shellQuote(dir)} && ${command}`)}`;
}

// rsync from Git for Windows speaks a newer protocol than it can negotiate with most servers.
export function rsyncPlatformFlags(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["--protocol=32"] : [];
}
