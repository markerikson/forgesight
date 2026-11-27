import type { WorkstreamConfig } from "./workstreams.ts";

export type RepoMode = "full" | "normal" | "simple";
/** `overview` groups the repo's PRs into workstreams; `triage` lists items one by one. */
export type RepoView = "overview" | "triage";
export type ContentLevel = "hidden" | "collapsed" | "show";
export type RebaseMethod = "api" | "range_diff";
export type AutoDoneMode = "log" | "send";

export interface BranchRule {
  pattern: RegExp;
  link: "issue";
}

export interface RepoConfig {
  mode: RepoMode;
  /** Upper bound for the adaptive batch size. */
  batchSize: number;
  branchRules: BranchRule[];
  view: RepoView;
  /** Base branches that are not part of a stack. */
  trunks: string[];
  /**
   * Files a push may change without counting as a change, compiled from globs. For generated files that
   * conflict resolution rewrites during a rebase.
   */
  rebaseIgnore: RegExp[];
  workstreams: WorkstreamConfig;
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
  ranking: {
    waiting: string[];
    /** A review request older than this, with nothing since, stops counting as waiting. */
    reviewRequestMaxAgeDays: number;
  };
  polling: {
    backfillDays: number;
    fullRefreshMinutes: number;
    /** How often to check GitHub for threads marked done elsewhere (github.com, mobile app). */
    doneSyncMinutes: number;
    openPullsMinutes: number;
    enrichIssues: boolean;
  };
  budget: { graphqlPerHour: number; restPerHour: number };
  rebase: { enabled: boolean; method: RebaseMethod };
  outbox: {
    /** Log queued GitHub writes and mark them sent without calling GitHub. For scratch databases. */
    dryRun: boolean;
    /**
     * Done subjects that GitHub brings back for noise only: `log` records the `done` writes it
     * would queue without sending them, `send` queues them for real.
     */
    autoDone: AutoDoneMode;
  };
  server: { port: number; allowedHosts: string[] };
  llm: {
    /** Spend stops for the rest of the UTC day once LLM calls total this much. */
    dailyCapUsd: number;
    tasks: { workstreamSummary: LlmTaskConfig };
    /** Keyed by model id. Every task model has an entry. */
    prices: Record<string, ModelPrice>;
  };
}

export type LlmProvider = "anthropic";

export interface LlmTaskConfig {
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function repoConfig(config: Config, repo: string): RepoConfig {
  const found = config.repos[repo] ?? config.repos["*"];
  if (!found) throw new Error(`No config for ${repo} and no "*" fallback`);
  return found;
}
