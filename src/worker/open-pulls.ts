import { openPullsMetaKey } from "../core/meta-keys.ts";
import { fetchOpenPulls, type OpenPullsListing } from "../github/queries/open-pulls.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import type { Job } from "./scheduler.ts";

function fetchedAt(text: string | undefined): number {
  if (!text) return 0;
  try {
    const at = Date.parse((JSON.parse(text) as Partial<OpenPullsListing>).fetchedAt ?? "");
    return Number.isNaN(at) ? 0 : at;
  } catch {
    return 0;
  }
}

/**
 * Lists open PRs for each `mode: "full"` repo every `polling.openPullsMinutes` and stores the
 * listing in meta `openPulls.<repo>`. One repo per run, the one fetched longest ago.
 */
export const openPullsJob: Job = {
  name: "openPulls",
  async run(ctx) {
    const { db, config, clock, log } = ctx;
    const repos = Object.entries(config.repos)
      .filter(([repo, rc]) => repo !== "*" && rc.mode === "full")
      .map(([repo]) => repo);
    if (repos.length === 0) return "idle";

    const intervalMs = config.polling.openPullsMinutes * 60_000;
    const now = clock().getTime();
    const due = repos
      .map((repo) => ({ repo, at: fetchedAt(getMeta(db, openPullsMetaKey(repo))) }))
      .filter((r) => now - r.at >= intervalMs)
      .sort((a, b) => a.at - b.at)[0];
    if (!due || !ctx.governor.canSpend("graphql", "openPulls")) return "idle";

    const listing = await fetchOpenPulls(ctx.gh, due.repo, clock);
    setMeta(db, openPullsMetaKey(due.repo), JSON.stringify(listing), listing.fetchedAt);
    log.info(`openPulls ${due.repo}: ${listing.pulls.length} open PRs`);
    return "worked";
  },
};
