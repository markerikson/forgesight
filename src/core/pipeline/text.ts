const MAX_LINE = 120;

/** Removes fenced code blocks and inline code spans. */
export function withoutCode(body: string): string {
  return body
    .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

function stripInline(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markdown and HTML to plain text: comments, tags, code fences and inline markup removed. */
export function stripMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^ {0,3}(```|~~~)[^\n]*$/gm, "")
    .replace(/<[^>\n]+>/g, "")
    .split(/\r?\n/)
    .map((line) =>
      stripInline(
        line
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/^\s*(>\s*)+/, "")
          .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, "")
          .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/, ""),
      ),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

export function truncate(text: string, max = MAX_LINE): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** First non-empty line of the plain text of a markdown body, truncated. */
export function firstLine(body: string, max = MAX_LINE): string {
  const line = stripMarkdown(body).split("\n")[0] ?? "";
  return truncate(line, max);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `body` @-mentions `login` outside code. */
export function mentions(body: string, login: string): boolean {
  const re = new RegExp(`(^|[^\\w/@.-])@${escapeRegex(login)}(?![\\w-])`, "i");
  return re.test(withoutCode(body));
}

/** Login without a trailing `[bot]`. */
export function bareLogin(login: string): string {
  return login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;
}

/** "AutoMergeEnabledEvent" to "auto merge enabled", for timeline types without a label. */
export function typenameLabel(typename: string): string {
  return typename
    .replace(/Event$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/** "closed", or "closed as not planned" / "closed as duplicate" from an issue's close reason. */
export function closeText(stateReason: string | undefined): string {
  if (stateReason === "NOT_PLANNED") return "closed as not planned";
  if (stateReason === "DUPLICATE") return "closed as duplicate";
  return "closed";
}

export function plural(count: number, noun: string): string {
  if (count === 1) return `${count} ${noun}`;
  const suffix = /(sh|ch|s|x)$/.test(noun) ? "es" : "s";
  return `${count} ${noun}${suffix}`;
}
