import { repoConfig } from "../core/config.ts";
import { openPullsMetaKey, recentlyClosedMetaKey } from "../core/meta-keys.ts";
import { nextRecentlyClosed } from "../core/recently-closed.ts";
import { fetchOpenPulls, type OpenPullsListing } from "../github/queries/open-pulls.ts";
import { getMeta, setMeta } from "../store/meta.ts";
import { getSubject } from "../store/subjects.ts";
import type { Job } from "./scheduler.ts";
import { readListing, readRecentlyClosed, rebuildAndLog, toWsPull } from "./workstreams.ts";

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
 * Lists open PRs for each `mode: "full"` or `view: "overview"` repo every
 * `polling.openPullsMinutes` and stores the listing in meta `openPulls.<repo>`, plus the PRs that
 * left the listing in the last 7 days in `openPulls.<repo>.recentlyClosed`. For overview repos
 * it then rebuilds the repo's workstreams. One repo per run, the one fetched longest ago.
 */
export const openPullsJob: Job = {
  name: "openPulls",
  async run(ctx) {
    const { db, config, clock, log } = ctx;
    const repos = Object.entries(config.repos)
      .filter(([repo, rc]) => repo !== "*" && (rc.mode === "full" || rc.view === "overview"))
      .map(([repo]) => repo);
    if (repos.length === 0) return "idle";

    const intervalMs = config.polling.openPullsMinutes * 60_000;
    const now = clock().getTime();
    const due = repos
      .map((repo) => ({ repo, at: fetchedAt(getMeta(db, openPullsMetaKey(repo))) }))
      .filter((r) => now - r.at >= intervalMs)
      .sort((a, b) => a.at - b.at)[0];
    if (!due || !ctx.governor.canSpend("graphql", "openPulls")) return "idle";

    const repo = due.repo;
    const previous = readListing(db, repo);
    const listing = await fetchOpenPulls(ctx.gh, repo, clock);
    const closed = nextRecentlyClosed(
      (previous?.pulls ?? []).map((p) => toWsPull(repo, p)),
      listing.pulls.map((p) => toWsPull(repo, p)),
      readRecentlyClosed(db, repo),
      (n) => getSubject(db, `${repo}#${n}`)?.state ?? null,
      clock(),
    );
    db.transaction(() => {
      setMeta(db, openPullsMetaKey(repo), JSON.stringify(listing), listing.fetchedAt);
      setMeta(db, recentlyClosedMetaKey(repo), JSON.stringify(closed), listing.fetchedAt);
    })();
    log.info(`openPulls ${repo}: ${listing.pulls.length} open PRs, ${closed.length} recently closed`);

    if (repoConfig(config, repo).view === "overview") rebuildAndLog(ctx, repo);
    return "worked";
  },
};
