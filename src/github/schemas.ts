import { type } from "arktype";
import { GitHubApiError } from "./errors.ts";
import type { CommitDetail, CommitFile, Compare, NotificationThread } from "./types.ts";

/** The fields we read from a REST notification thread. Extra fields are allowed and kept in `raw`. */
export const restNotification = type({
  id: "string",
  repository: { full_name: "string" },
  subject: { title: "string", url: "string | null", type: "string" },
  reason: "string",
  unread: "boolean",
  updated_at: "string",
  last_read_at: "string | null",
});

export const restUser = type({ login: "string" });

const restCommitFile = type({
  filename: "string",
  status: "string",
  additions: "number",
  deletions: "number",
  "patch?": "string",
  "previous_filename?": "string",
});

export const restCommit = type({
  sha: "string",
  parents: type({ sha: "string" }).array(),
  commit: { message: "string", tree: { sha: "string" } },
  "files?": restCommitFile.array(),
});

export const restCompare = type({
  status: "'ahead' | 'behind' | 'diverged' | 'identical'",
  ahead_by: "number",
  behind_by: "number",
  merge_base_commit: { sha: "string" },
  commits: type({ sha: "string" }).array(),
  "files?": restCommitFile.array(),
});

function parse<T>(schema: { (data: unknown): T | InstanceType<typeof type.errors> }, raw: unknown, what: string): T {
  const out = schema(raw);
  if (out instanceof type.errors) {
    throw new GitHubApiError(`Unexpected ${what} shape from GitHub: ${out.summary}`, 200);
  }
  return out;
}

export function toNotificationThread(raw: unknown): NotificationThread {
  const n = parse(restNotification, raw, "notification");
  return {
    id: n.id,
    repo: n.repository.full_name,
    subjectType: n.subject.type,
    subjectUrl: n.subject.url,
    subjectTitle: n.subject.title,
    reason: n.reason,
    unread: n.unread,
    updatedAt: n.updated_at,
    lastReadAt: n.last_read_at,
    raw,
  };
}

export function toLogin(raw: unknown): string {
  return parse(restUser, raw, "user").login;
}

function toFiles(files: (typeof restCommitFile.infer)[] | undefined): CommitFile[] {
  return (files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
    previousFilename: f.previous_filename ?? null,
  }));
}

export function toCommitDetail(raw: unknown): CommitDetail {
  const c = parse(restCommit, raw, "commit");
  return {
    sha: c.sha,
    parents: c.parents.map((p) => p.sha),
    treeSha: c.commit.tree.sha,
    message: c.commit.message,
    files: toFiles(c.files),
    raw,
  };
}

export function toCompare(raw: unknown): Compare {
  const c = parse(restCompare, raw, "compare");
  return {
    status: c.status,
    aheadBy: c.ahead_by,
    behindBy: c.behind_by,
    mergeBaseSha: c.merge_base_commit.sha,
    commitShas: c.commits.map((x) => x.sha),
    files: toFiles(c.files),
    raw,
  };
}
