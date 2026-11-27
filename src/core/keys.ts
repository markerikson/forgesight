import type { SubjectKey } from "./types.ts";

const NUMBERED_SUBJECT = /\/repos\/[^/]+\/[^/]+\/(?:pulls|issues|discussions)\/(\d+)$/;

/**
 * `owner/repo#N` for a pull request, issue or discussion (they share one number space per
 * repo), `owner/repo@<thread id>` for any other subject (releases, check suites, ...).
 */
export function subjectKeyFor(thread: {
  id: string;
  repo: string;
  subjectUrl: string | null;
}): SubjectKey {
  const match = thread.subjectUrl ? NUMBERED_SUBJECT.exec(thread.subjectUrl) : null;
  if (match) return `${thread.repo}#${match[1]}`;
  return `${thread.repo}@${thread.id}`;
}
