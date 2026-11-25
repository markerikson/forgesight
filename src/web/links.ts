const NUMBERED_KEY = /^([^#@]+)#(\d+)$/;
const GITHUB_SUBJECT_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)\/?(?:[?#].*)?$/;

/** GitHub page of a numbered subject key (`owner/repo#12`); GitHub redirects issue URLs of PRs. */
export function githubUrlForKey(key: string): string | null {
  const match = NUMBERED_KEY.exec(key);
  return match ? `https://github.com/${match[1]}/issues/${match[2]}` : null;
}

/** Subject key of a GitHub PR or issue URL, or null for any other URL. */
export function subjectKeyForUrl(url: string): string | null {
  const match = GITHUB_SUBJECT_URL.exec(url);
  return match ? `${match[1]}#${match[2]}` : null;
}

/** A plain left click. Modified and middle clicks are left to the browser, which opens a new tab or window. */
export function isPlainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
