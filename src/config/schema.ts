import { type } from "arktype";

const level = type("'hidden' | 'collapsed' | 'show'");

const repoEntry = type({
  "+": "reject",
  "mode?": "'full' | 'normal' | 'simple'",
  "batchSize?": "number.integer >= 1",
  "branchRules?": type({ "+": "reject", pattern: "string", link: "'issue'" }).array(),
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
  "server?": {
    "+": "reject",
    "port?": "1 <= number.integer <= 65535",
    "allowedHosts?": "string[]",
  },
});

export type UserConfig = typeof userConfigSchema.infer;
export type UserRepoConfig = typeof repoEntry.infer;
export type UserRule = typeof rule.infer;
