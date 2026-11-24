import type { SubjectKey } from "./types.ts";

const NUMBERED_SUBJECT = /\/repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/(\d+)$/;

/**
 * `owner/repo#N` for a pull request or issue, `owner/repo@<thread id>` for any other
 * subject (releases, discussions, check suites, ...).
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
