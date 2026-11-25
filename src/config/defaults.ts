import type { UserConfig, UserRule } from "./schema.ts";

/**
 * Built-in bot catalog. The first rule whose `match` conditions all hold decides an event's
 * level. Rules match on body markers where a bot has one, because the same account
 * (github-actions) posts several kinds of comments and agent output posts under human logins.
 */
/** URL characters, stopping at whitespace, quotes, angle brackets and markdown link syntax. */
const URL_CHARS = "[^\\s()\\[\\]\"'<>]";

const bots: UserRule[] = [
  {
    id: "diffloupe",
    match: { author: "github-actions", htmlMarker: "ai-review kind=summary" },
    kind: "review",
    level: "collapsed",
    findings: "diffloupe",
  },
  // DiffLoupe status notes ("Reviews stopped", per-round notes) from any account.
  { id: "diffloupe-note", match: { htmlMarker: "<!-- ai-review" }, kind: "review", level: "collapsed" },
  { id: "coderabbit", match: { author: "coderabbitai" }, kind: "review", level: "collapsed" },
  {
    id: "socket",
    match: { author: "socket-security" },
    kind: "status",
    level: "hidden",
    // Dependency alerts matter on my own PRs; on others' PRs the author handles them.
    override: [{ bodyRegex: "\\[!CAUTION\\]", level: "show", onlyMine: true }],
  },
  {
    id: "netlify",
    match: { author: "netlify" },
    kind: "preview",
    level: "hidden",
    extract: { url: `https://${URL_CHARS}+\\.netlify\\.app${URL_CHARS}*` },
  },
  {
    id: "vercel",
    match: { author: "vercel" },
    kind: "preview",
    level: "hidden",
    extract: { url: `https://${URL_CHARS}+\\.vercel\\.app${URL_CHARS}*` },
  },
  {
    id: "pkg-pr-new",
    match: { author: "pkg-pr-new" },
    kind: "preview",
    level: "hidden",
    extract: { url: `https://pkg\\.pr\\.new/${URL_CHARS}+` },
  },
  { id: "codesandbox", match: { author: "codesandbox-ci" }, kind: "preview", level: "hidden" },
  {
    id: "replay-qa",
    match: { htmlMarker: "<!-- replay-qa-bot -->" },
    kind: "ci",
    level: "collapsed",
    findings: "replay-qa",
  },
  { id: "replay-evals", match: { author: "replay-evals" }, kind: "ci", level: "collapsed" },
  { id: "replay-soc2", match: { author: "replay-soc2" }, kind: "status", level: "hidden" },
  { id: "codecov", match: { author: "codecov" }, kind: "status", level: "hidden" },
  { id: "changeset-bot", match: { author: "changeset-bot" }, kind: "status", level: "hidden" },
  { id: "dependabot", match: { author: "dependabot" }, kind: "dependency", level: "collapsed" },
  { id: "renovate", match: { author: "renovate" }, kind: "dependency", level: "collapsed" },
  // Size reports, deploy notes and other workflow output.
  { id: "github-actions", match: { author: "github-actions" }, kind: "ci", level: "hidden" },
];

/** Human-posted comments that are really agent or automation output. */
const contentRules: UserRule[] = [
  { id: "agent-superseded", match: { bodyRegex: "^\\s*🤖 Superseded" }, level: "collapsed" },
  { id: "agent-verdict", match: { bodyRegex: "^\\s*🤖 Approve" }, level: "hidden" },
  { id: "agent-note", match: { bodyRegex: "^\\s*🤖" }, level: "collapsed" },
  { id: "vehicle-done", match: { bodyRegex: "^\\s*Vehicle done" }, level: "collapsed" },
  { id: "evals-fix-report", match: { htmlMarker: "<!-- replay-evals-fix-report -->" }, level: "collapsed" },
  { id: "loop-qa-preview", match: { bodyRegex: "^\\s*\\S+ \\*\\*Loop QA preview\\*\\*" }, level: "collapsed" },
];

/** Built-in defaults, in the same shape as the user file. */
export const defaultConfig = {
  repos: {
    "*": {
      mode: "normal",
      batchSize: 10,
      view: "triage",
      trunks: ["master", "main"],
      workstreams: {
        forkMinSize: 5,
        // "[never merge]", "[base, never merge]", "CI vehicle (never merge)" ...
        cutBelow: ["[[(][^\\])]*never merge[^\\])]*[\\])]"],
        genericPrefixes: [],
        botAuthors: [],
        groups: [],
      },
    },
  },
  bots,
  contentRules,
  ranking: {
    waiting: ["reviewRequested", "humanActivity", "newFindings", "socketCaution", "ownCiFailure"],
    reviewRequestMaxAgeDays: 7,
  },
  polling: {
    backfillDays: 90,
    fullRefreshMinutes: 15,
    openPullsMinutes: 10,
    enrichIssues: true,
  },
  budget: { graphqlPerHour: 1000, restPerHour: 1500 },
  rebase: { enabled: true, method: "api" },
  outbox: { dryRun: false },
  server: { port: 4630, allowedHosts: ["localhost", "127.0.0.1"] },
  llm: {
    dailyCapUsd: 2,
    tasks: { workstreamSummary: { provider: "anthropic", model: "claude-haiku-4-5" } },
    prices: {
      "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  },
} satisfies UserConfig;
