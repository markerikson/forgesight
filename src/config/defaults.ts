import type { UserConfig } from "./schema.ts";

/**
 * Built-in defaults, in the same shape as the user file. The bot catalog is
 * added with the pipeline work.
 */
export const defaultConfig = {
  repos: {
    "*": { mode: "normal", batchSize: 10 },
  },
  bots: [],
  contentRules: [],
  ranking: {
    waiting: ["reviewRequested", "humanActivity", "newFindings", "socketCaution", "ownCiFailure"],
  },
  polling: {
    backfillDays: 90,
    fullRefreshMinutes: 15,
    openPullsMinutes: 10,
    enrichIssues: true,
  },
  budget: { graphqlPerHour: 1000, restPerHour: 1500 },
  rebase: { enabled: true, method: "api" },
  server: { port: 4630, allowedHosts: ["localhost", "127.0.0.1"] },
} satisfies UserConfig;
