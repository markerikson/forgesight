export type RepoMode = "full" | "normal" | "simple";
export type ContentLevel = "hidden" | "collapsed" | "show";
export type RebaseMethod = "api" | "range_diff";

export interface BranchRule {
  pattern: RegExp;
  link: "issue";
}

export interface RepoConfig {
  mode: RepoMode;
  /** Upper bound for the adaptive batch size. */
  batchSize: number;
  branchRules: BranchRule[];
}

export interface RuleMatch {
  author?: string;
  htmlMarker?: string;
  bodyRegex?: RegExp;
}

export interface RuleOverride {
  bodyRegex: RegExp;
  level: ContentLevel;
  /** Apply only on subjects I opened; elsewhere the rule's own level stands. */
  onlyMine: boolean;
}

/** A bot or content rule: how matching comments are classified and shown. */
export interface ContentRule {
  id: string;
  match: RuleMatch;
  kind?: string;
  level: ContentLevel;
  findings?: string;
  override: RuleOverride[];
  extract: Record<string, RegExp>;
}

export interface Config {
  /** Viewer login. `null` means "use the token's login", resolved at worker start. */
  me: string | null;
  /** Keyed by `owner/repo`; `"*"` is the fallback and is always present. */
  repos: Record<string, RepoConfig>;
  bots: ContentRule[];
  contentRules: ContentRule[];
  ranking: { waiting: string[] };
  polling: {
    backfillDays: number;
    fullRefreshMinutes: number;
    openPullsMinutes: number;
    enrichIssues: boolean;
  };
  budget: { graphqlPerHour: number; restPerHour: number };
  rebase: { enabled: boolean; method: RebaseMethod };
  server: { port: number; allowedHosts: string[] };
}

export function repoConfig(config: Config, repo: string): RepoConfig {
  const found = config.repos[repo] ?? config.repos["*"];
  if (!found) throw new Error(`No config for ${repo} and no "*" fallback`);
  return found;
}
