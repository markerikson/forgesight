// Fetch force-push and base-change timeline events for a repo's recent PRs, for repos not in .data/inbox.db.
// Usage: bun spikes/rebase/fetch-repo.ts owner/name [maxPrs]
import { $ } from "bun";
import { writeFileSync } from "node:fs";

const [owner, name] = (process.argv[2] ?? "replayio/loop-qa").split("/");
const maxPrs = Number(process.argv[3] ?? 300);

const query = `query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    defaultBranchRef{name}
    pullRequests(first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number author{login} baseRefName headRefName state updatedAt
        timelineItems(first:100,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT,BASE_REF_FORCE_PUSHED_EVENT,BASE_REF_CHANGED_EVENT,AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]){
          totalCount
          nodes{
            __typename
            ... on HeadRefForcePushedEvent{id createdAt actor{login} beforeCommit{oid} afterCommit{oid}}
            ... on BaseRefForcePushedEvent{id createdAt actor{login} beforeCommit{oid} afterCommit{oid}}
            ... on BaseRefChangedEvent{id createdAt actor{login} previousRefName currentRefName}
            ... on AutomaticBaseChangeSucceededEvent{id createdAt oldBase newBase}
          }
        }
      }
    }
  }
}`;

interface Node {
  __typename: string;
  id: string;
  createdAt: string;
  [k: string]: unknown;
}
interface Pr {
  number: number;
  author: { login: string } | null;
  baseRefName: string;
  state: string;
  updatedAt: string;
  timelineItems: { totalCount: number; nodes: Node[] };
}

const subjects: { subject_key: string; number: number; author: string; base_ref: string; state: string }[] = [];
const events: Record<string, { node_id: string; typename: string; created_at: string; raw: Node }[]> = {};
let cursor: string | null = null;
let trunk = "main";
let truncated = 0;
while (subjects.length < maxPrs) {
  const args = ["-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
  if (cursor) args.push("-F", `cursor=${cursor}`);
  const res = JSON.parse((await $`gh api graphql ${args}`.quiet()).stdout.toString());
  const repo = res.data.repository;
  trunk = repo.defaultBranchRef.name;
  for (const pr of repo.pullRequests.nodes as Pr[]) {
    const key = `${owner}/${name}#${pr.number}`;
    if (pr.timelineItems.totalCount > 100) truncated++;
    subjects.push({ subject_key: key, number: pr.number, author: pr.author?.login ?? "", base_ref: pr.baseRefName, state: pr.state });
    events[key] = pr.timelineItems.nodes.map((n) => ({ node_id: n.id, typename: n.__typename, created_at: n.createdAt, raw: n }));
  }
  if (!repo.pullRequests.pageInfo.hasNextPage) break;
  cursor = repo.pullRequests.pageInfo.endCursor;
}
const out = `/tmp/opencode/rebase/${name}-events.json`;
writeFileSync(out, JSON.stringify({ repo: `${owner}/${name}`, trunk, fetchedAt: new Date().toISOString(), subjects, events }, null, 2));
const all = Object.values(events).flat();
const count = (t: string) => all.filter((e) => e.typename === t).length;
console.log({
  out,
  trunk,
  prs: subjects.length,
  truncated,
  oldestUpdated: subjects.at(-1),
  heads: count("HeadRefForcePushedEvent"),
  baseForces: count("BaseRefForcePushedEvent"),
  refChanged: count("BaseRefChangedEvent"),
  autoBase: count("AutomaticBaseChangeSucceededEvent"),
});
