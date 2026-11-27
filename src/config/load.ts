import { type } from "arktype";
import type {
  BranchRule,
  Config,
  ContentRule,
  LlmTaskConfig,
  ModelPrice,
  RepoConfig,
} from "../core/config.ts";
import type { WorkstreamConfig } from "../core/workstreams.ts";
import { defaultConfig } from "./defaults.ts";
import { type UserConfig, type UserRepoConfig, type UserRule, userConfigSchema } from "./schema.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadedConfig {
  config: Config;
  hash: string;
  error?: string;
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new ConfigError(`Missing default for ${field}`);
  return value;
}

function compile(source: string, where: string, flags?: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new ConfigError(`Invalid regex in ${where}: ${(err as Error).message}`);
  }
}

/**
 * `*` and `?` stay within one path segment, `**` spans segments. A glob without `/` matches the file name
 * in any directory.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      const slash = glob.charAt(i + 2) === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${glob.includes("/") ? "" : "(?:.*/)?"}${source}$`);
}

/** Workstream patterns are case-insensitive. Each field replaces the inherited one. */
function resolveWorkstreams(
  entry: UserRepoConfig["workstreams"],
  base: WorkstreamConfig | undefined,
  key: string,
): WorkstreamConfig {
  const at = `repos["${key}"].workstreams`;
  const patterns = (sources: string[], where: string) =>
    sources.map((s, i) => compile(s, `${where}[${i}]`, "i"));
  return {
    forkMinSize: required(entry?.forkMinSize ?? base?.forkMinSize, `${at}.forkMinSize`),
    cutBelow: entry?.cutBelow
      ? patterns(entry.cutBelow, `${at}.cutBelow`)
      : required(base?.cutBelow, `${at}.cutBelow`),
    genericPrefixes: (entry?.genericPrefixes ?? base?.genericPrefixes ?? []).map((p) => p.toLowerCase()),
    titleAliases: entry?.titleAliases
      ? entry.titleAliases.map((a, i) => ({
          match: compile(a.match, `${at}.titleAliases[${i}].match`, "i"),
          replace: a.replace,
        }))
      : (base?.titleAliases ?? []),
    botAuthors: entry?.botAuthors ?? base?.botAuthors ?? [],
    groups: entry?.groups
      ? entry.groups.map((g, i) => {
          if (!g.titles?.length && !g.branches?.length) {
            throw new ConfigError(`${at}.groups[${i}] needs titles or branches`);
          }
          return {
            name: g.name,
            titles: patterns(g.titles ?? [], `${at}.groups[${i}].titles`),
            branches: patterns(g.branches ?? [], `${at}.groups[${i}].branches`),
            authors: g.authors ?? [],
          };
        })
      : (base?.groups ?? []),
  };
}

function resolveRepo(entry: UserRepoConfig, base: Partial<RepoConfig>, key: string): RepoConfig {
  const branchRules: BranchRule[] | undefined = entry.branchRules?.map((r, i) => ({
    pattern: compile(r.pattern, `repos["${key}"].branchRules[${i}].pattern`),
    link: r.link,
  }));
  return {
    mode: required(entry.mode ?? base.mode, `repos["${key}"].mode`),
    batchSize: required(entry.batchSize ?? base.batchSize, `repos["${key}"].batchSize`),
    branchRules: branchRules ?? base.branchRules ?? [],
    view: required(entry.view ?? base.view, `repos["${key}"].view`),
    trunks: required(entry.trunks ?? base.trunks, `repos["${key}"].trunks`),
    rebaseIgnore: entry.rebaseIgnore?.map(globToRegExp) ?? base.rebaseIgnore ?? [],
    workstreams: resolveWorkstreams(entry.workstreams, base.workstreams, key),
  };
}

function resolveRepos(
  user: UserConfig["repos"],
  defaults: UserConfig["repos"],
): Record<string, RepoConfig> {
  const star = resolveRepo(
    user?.["*"] ?? {},
    resolveRepo(defaults?.["*"] ?? {}, {}, "*"),
    "*",
  );
  const repos: Record<string, RepoConfig> = { "*": star };
  const keys = new Set([...Object.keys(defaults ?? {}), ...Object.keys(user ?? {})]);
  keys.delete("*");
  for (const key of keys) {
    const fromDefaults = defaults?.[key];
    const base = fromDefaults ? resolveRepo(fromDefaults, star, key) : star;
    repos[key] = resolveRepo(user?.[key] ?? {}, base, key);
  }
  return repos;
}

function resolveRule(rule: UserRule, where: string): ContentRule {
  const at = `${where}["${rule.id}"]`;
  const match: ContentRule["match"] = {};
  if (rule.match.author !== undefined) match.author = rule.match.author;
  if (rule.match.htmlMarker !== undefined) match.htmlMarker = rule.match.htmlMarker;
  if (rule.match.bodyRegex !== undefined) {
    match.bodyRegex = compile(rule.match.bodyRegex, `${at}.match.bodyRegex`);
  }
  const resolved: ContentRule = {
    id: rule.id,
    match,
    level: rule.level ?? "show",
    override: (rule.override ?? []).map((o, i) => ({
      bodyRegex: compile(o.bodyRegex, `${at}.override[${i}].bodyRegex`),
      level: o.level,
      onlyMine: o.onlyMine ?? false,
    })),
    extract: Object.fromEntries(
      Object.entries(rule.extract ?? {}).map(([name, source]) => [
        name,
        compile(source, `${at}.extract.${name}`),
      ]),
    ),
  };
  if (rule.kind !== undefined) resolved.kind = rule.kind;
  if (rule.findings !== undefined) resolved.findings = rule.findings;
  return resolved;
}

/** A user rule with the same id replaces the default rule; new ids are appended. */
function resolveRules(
  user: UserRule[] | undefined,
  defaults: UserRule[] | undefined,
  where: string,
): ContentRule[] {
  const byId = new Map<string, UserRule>();
  for (const rule of defaults ?? []) byId.set(rule.id, rule);
  for (const rule of user ?? []) byId.set(rule.id, rule);
  return [...byId.values()].map((rule) => resolveRule(rule, where));
}

/** Merges a validated user config over the defaults and compiles regexes. Throws `ConfigError`. */
export function resolveConfig(user: UserConfig, defaults: UserConfig = defaultConfig): Config {
  const d = {
    ranking: required(defaults.ranking, "ranking"),
    polling: required(defaults.polling, "polling"),
    budget: required(defaults.budget, "budget"),
    rebase: required(defaults.rebase, "rebase"),
    outbox: required(defaults.outbox, "outbox"),
    server: required(defaults.server, "server"),
  };
  return {
    me: user.me ?? defaults.me ?? null,
    repos: resolveRepos(user.repos, defaults.repos),
    bots: resolveRules(user.bots, defaults.bots, "bots"),
    contentRules: resolveRules(user.contentRules, defaults.contentRules, "contentRules"),
    ranking: {
      waiting: required(user.ranking?.waiting ?? d.ranking.waiting, "ranking.waiting"),
      reviewRequestMaxAgeDays: required(
        user.ranking?.reviewRequestMaxAgeDays ?? d.ranking.reviewRequestMaxAgeDays,
        "ranking.reviewRequestMaxAgeDays",
      ),
    },
    polling: {
      backfillDays: required(
        user.polling?.backfillDays ?? d.polling.backfillDays,
        "polling.backfillDays",
      ),
      fullRefreshMinutes: required(
        user.polling?.fullRefreshMinutes ?? d.polling.fullRefreshMinutes,
        "polling.fullRefreshMinutes",
      ),
      doneSyncMinutes: required(
        user.polling?.doneSyncMinutes ?? d.polling.doneSyncMinutes,
        "polling.doneSyncMinutes",
      ),
      openPullsMinutes: required(
        user.polling?.openPullsMinutes ?? d.polling.openPullsMinutes,
        "polling.openPullsMinutes",
      ),
      enrichIssues: required(
        user.polling?.enrichIssues ?? d.polling.enrichIssues,
        "polling.enrichIssues",
      ),
    },
    budget: {
      graphqlPerHour: required(
        user.budget?.graphqlPerHour ?? d.budget.graphqlPerHour,
        "budget.graphqlPerHour",
      ),
      restPerHour: required(
        user.budget?.restPerHour ?? d.budget.restPerHour,
        "budget.restPerHour",
      ),
    },
    rebase: {
      enabled: required(user.rebase?.enabled ?? d.rebase.enabled, "rebase.enabled"),
      method: required(user.rebase?.method ?? d.rebase.method, "rebase.method"),
    },
    outbox: {
      dryRun: required(user.outbox?.dryRun ?? d.outbox.dryRun, "outbox.dryRun"),
      autoDone: required(user.outbox?.autoDone ?? d.outbox.autoDone, "outbox.autoDone"),
    },
    server: {
      port: required(user.server?.port ?? d.server.port, "server.port"),
      allowedHosts: required(
        user.server?.allowedHosts ?? d.server.allowedHosts,
        "server.allowedHosts",
      ),
    },
    llm: resolveLlm(user.llm, required(defaults.llm, "llm")),
  };
}

type UserLlm = NonNullable<UserConfig["llm"]>;
type UserLlmTask = NonNullable<NonNullable<UserLlm["tasks"]>["workstreamSummary"]>;

function resolveLlmTask(
  user: UserLlmTask | undefined,
  defaults: UserLlmTask | undefined,
  prices: Record<string, ModelPrice>,
  where: string,
): LlmTaskConfig {
  const task: LlmTaskConfig = {
    provider: required(user?.provider ?? defaults?.provider, `${where}.provider`),
    model: required(user?.model ?? defaults?.model, `${where}.model`),
  };
  const baseUrl = user?.baseUrl ?? defaults?.baseUrl;
  if (baseUrl !== undefined) task.baseUrl = baseUrl;
  if (!prices[task.model]) {
    throw new ConfigError(`${where}.model "${task.model}" has no entry in llm.prices`);
  }
  return task;
}

function resolveLlm(user: UserLlm | undefined, defaults: UserLlm): Config["llm"] {
  const prices = { ...defaults.prices, ...user?.prices };
  return {
    dailyCapUsd: required(user?.dailyCapUsd ?? defaults.dailyCapUsd, "llm.dailyCapUsd"),
    tasks: {
      workstreamSummary: resolveLlmTask(
        user?.tasks?.workstreamSummary,
        defaults.tasks?.workstreamSummary,
        prices,
        "llm.tasks.workstreamSummary",
      ),
    },
    prices,
  };
}

function canonicalize(value: unknown): unknown {
  if (value instanceof RegExp) return value.flags ? `/${value.source}/${value.flags}` : value.source;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Canonical JSON: sorted keys at every level, regexes written as their source. */
export function canonicalJson(config: Config): string {
  return JSON.stringify(canonicalize(config));
}

export function configHash(config: Config): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJson(config)).digest("hex");
}

/** Parses and validates JSONC text. Throws `ConfigError`. */
export function parseConfigText(text: string, defaults: UserConfig = defaultConfig): Config {
  let raw: unknown;
  try {
    raw = Bun.JSONC.parse(text);
  } catch (err) {
    throw new ConfigError(`Config is not valid JSONC: ${(err as Error).message}`);
  }
  const user = userConfigSchema(raw ?? {});
  if (user instanceof type.errors) throw new ConfigError(`Invalid config: ${user.summary}`);
  return resolveConfig(user, defaults);
}

/**
 * Reads the config file. A missing file gives the defaults. An unreadable or
 * invalid file gives the defaults plus an `error` so the worker can keep running.
 */
export async function loadConfig(
  path: string,
  defaults: UserConfig = defaultConfig,
): Promise<LoadedConfig> {
  const fallback = (): LoadedConfig => {
    const config = resolveConfig({}, defaults);
    return { config, hash: configHash(config) };
  };
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback();
  try {
    const config = parseConfigText(await file.text(), defaults);
    return { config, hash: configHash(config) };
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : `Could not read ${path}: ${String(err)}`;
    return { ...fallback(), error: message };
  }
}
