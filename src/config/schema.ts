import { type } from "arktype";

const level = type("'hidden' | 'collapsed' | 'show'");

const repoEntry = type({
  "+": "reject",
  "mode?": "'full' | 'normal' | 'simple'",
  "batchSize?": "number.integer >= 1",
  "branchRules?": type({ "+": "reject", pattern: "string", link: "'issue'" }).array(),
  "view?": "'overview' | 'triage'",
  "trunks?": "string[]",
  "workstreams?": {
    "+": "reject",
    "forkMinSize?": "number.integer >= 2",
    "cutBelow?": "string[]",
    "genericPrefixes?": "string[]",
    "botAuthors?": "string[]",
    "groups?": type({
      "+": "reject",
      name: "string > 0",
      "titles?": "string[]",
      "branches?": "string[]",
      "authors?": "string[]",
    }).array(),
  },
});

const rule = type({
  "+": "reject",
  id: "string > 0",
  match: {
    "+": "reject",
    "author?": "string",
    "htmlMarker?": "string",
    "bodyRegex?": "string",
  },
  "kind?": "string",
  "level?": level,
  "findings?": "string",
  "override?": type({ "+": "reject", bodyRegex: "string", level, "onlyMine?": "boolean" }).array(),
  "extract?": "Record<string, string>",
});

const positiveInt = "number.integer >= 1";

const llmTask = type({
  "+": "reject",
  "provider?": "'anthropic'",
  "model?": "string > 0",
  "baseUrl?": "string > 0",
});

/** USD per million tokens. */
const modelPrice = type({
  "+": "reject",
  input: "number >= 0",
  output: "number >= 0",
  cacheRead: "number >= 0",
  cacheWrite: "number >= 0",
});

/** Shape of the user's `config.jsonc`. Every field is optional; defaults fill the rest. */
export const userConfigSchema = type({
  "+": "reject",
  "$schema?": "string",
  "me?": "string",
  "repos?": type({ "[string]": repoEntry }),
  "bots?": rule.array(),
  "contentRules?": rule.array(),
  "ranking?": { "+": "reject", "waiting?": "string[]", "reviewRequestMaxAgeDays?": positiveInt },
  "polling?": {
    "+": "reject",
    "backfillDays?": positiveInt,
    "fullRefreshMinutes?": positiveInt,
    "openPullsMinutes?": positiveInt,
    "enrichIssues?": "boolean",
  },
  "budget?": {
    "+": "reject",
    "graphqlPerHour?": positiveInt,
    "restPerHour?": positiveInt,
  },
  "rebase?": {
    "+": "reject",
    "enabled?": "boolean",
    "method?": "'api' | 'range_diff'",
  },
  "outbox?": {
    "+": "reject",
    "dryRun?": "boolean",
  },
  "server?": {
    "+": "reject",
    "port?": "1 <= number.integer <= 65535",
    "allowedHosts?": "string[]",
  },
  "llm?": {
    "+": "reject",
    "dailyCapUsd?": "number >= 0",
    "tasks?": {
      "+": "reject",
      "workstreamSummary?": llmTask,
    },
    "prices?": type({ "[string]": modelPrice }),
  },
});

export type UserConfig = typeof userConfigSchema.infer;
export type UserRepoConfig = typeof repoEntry.infer;
export type UserRule = typeof rule.infer;
