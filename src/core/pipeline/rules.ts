import type { ContentLevel, ContentRule } from "../config.ts";
import { bareLogin, withoutCode } from "./text.ts";
import type { Actor, BotKind, Extracted } from "./types.ts";

const BOT_KINDS: ReadonlySet<string> = new Set<BotKind>(["review", "ci", "preview", "status", "dependency", "discussion"]);

function test(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

function firstMatch(re: RegExp, text: string): string | undefined {
  re.lastIndex = 0;
  return re.exec(text)?.[0];
}

/** True when every condition the rule sets holds. A rule with no conditions never matches. */
export function ruleMatches(rule: ContentRule, actor: Actor | null, body: string): boolean {
  const { author, htmlMarker, bodyRegex } = rule.match;
  if (author === undefined && htmlMarker === undefined && bodyRegex === undefined) return false;
  // Actor logins have `[bot]` stripped; accept either form in config.
  if (author !== undefined && actor?.login.toLowerCase() !== bareLogin(author).toLowerCase()) return false;
  if (htmlMarker !== undefined && !withoutCode(body).includes(htmlMarker)) return false;
  if (bodyRegex !== undefined && !test(bodyRegex, body)) return false;
  return true;
}

export function findRule(rules: ContentRule[], actor: Actor | null, body: string): ContentRule | undefined {
  return rules.find((r) => ruleMatches(r, actor, body));
}

/**
 * The rule's level, or the level of its first override whose regex matches the body.
 * Overrides marked `onlyMine` are skipped on subjects someone else opened.
 */
export function ruleLevel(rule: ContentRule, body: string, mySubject: boolean): ContentLevel {
  return rule.override.find((o) => (mySubject || !o.onlyMine) && test(o.bodyRegex, body))?.level ?? rule.level;
}

export function ruleBotKind(rule: ContentRule): BotKind | undefined {
  return rule.kind !== undefined && BOT_KINDS.has(rule.kind) ? (rule.kind as BotKind) : undefined;
}

/** Values pulled out of the body by the rule's `extract` patterns. Only `url` is used in v0. */
export function extract(rule: ContentRule, body: string): Extracted | undefined {
  const pattern = rule.extract.url;
  if (!pattern) return undefined;
  const url = firstMatch(pattern, body);
  return url ? { url } : undefined;
}
