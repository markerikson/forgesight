import type { Config, ContentLevel, RepoMode } from "../config.ts";
import { extract, findRule, ruleBotKind, ruleLevel } from "./rules.ts";
import { isAfter } from "./time.ts";
import type { SubjectKind } from "../types.ts";
import type { Event, EventKind, ViewEvent } from "./types.ts";

const BODY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["comment", "review", "reviewComment"]);

const DEFAULT_LEVEL: Record<EventKind, ContentLevel> = {
  comment: "show",
  review: "show",
  reviewComment: "show",
  merged: "show",
  closed: "show",
  reopened: "show",
  readyForReview: "show",
  closedByPr: "show",
  markedDuplicate: "show",
  connected: "show",
  reviewDismissed: "show",
  reviewRequested: "collapsed",
  commit: "collapsed",
  forcePush: "collapsed",
  baseForcePush: "collapsed",
  crossReference: "collapsed",
  reference: "collapsed",
  renamed: "collapsed",
  baseChanged: "collapsed",
  labeled: "collapsed",
  assigned: "collapsed",
  stack: "collapsed",
  convertToDraft: "collapsed",
  reviewRequestRemoved: "collapsed",
  transferred: "collapsed",
  subIssue: "collapsed",
  milestoned: "collapsed",
  mentioned: "hidden",
  unknown: "collapsed",
};

export interface ClassifyContext {
  config: Pick<Config, "bots" | "contentRules">;
  me: string | null;
  mode: RepoMode;
  /** Assignment to me is shown on issues only; on PRs it is usually bookkeeping. */
  subjectKind: SubjectKind;
  /** I opened the subject; enables rule overrides marked `onlyMine`. */
  mySubject: boolean;
  /** Events after this time are new; null means everything is new. */
  dismissedAt: string | null;
}

export function isMe(login: string | undefined, me: string | null): boolean {
  return me !== null && login !== undefined && login.toLowerCase() === me.toLowerCase();
}

/** A comment or review whose display level came from the human default, not a rule. */
export function isHumanText(e: ViewEvent): boolean {
  return BODY_KINDS.has(e.kind) && e.actor !== null && !e.actor.isBot && e.ruleId === undefined;
}

function classifyOne(e: Event, ctx: ClassifyContext): Omit<ViewEvent, keyof Event | "isNew"> {
  if (e.kind === "mentioned") return { level: isMe(e.data.target, ctx.me) ? "show" : "hidden" };
  if (e.kind === "reviewRequested" && isMe(e.data.target, ctx.me)) return { level: "show" };
  if (e.kind === "crossReference" && e.data.willClose === true) return { level: "show" };
  if (e.kind === "assigned" && ctx.subjectKind === "issue" && e.data.added !== false && isMe(e.data.target, ctx.me)) {
    return { level: "show" };
  }
  if (BODY_KINDS.has(e.kind)) {
    const body = e.body ?? "";
    const rule = findRule(ctx.config.bots, e.actor, body) ?? findRule(ctx.config.contentRules, e.actor, body);
    if (rule) {
      const out: Omit<ViewEvent, keyof Event | "isNew"> = { level: ruleLevel(rule, body, ctx.mySubject), ruleId: rule.id };
      const botKind = ruleBotKind(rule);
      if (botKind) out.botKind = botKind;
      const extracted = extract(rule, body);
      if (extracted) out.extracted = extracted;
      return out;
    }
    // Bots without a catalog rule are collapsed, never hidden, so new bots stay visible.
    if (e.actor?.isBot) return { level: "collapsed" };
    return { level: "show" };
  }
  return { level: DEFAULT_LEVEL[e.kind] };
}

/**
 * Gives each event a display level from the bot catalog, content rules and kind defaults.
 * In simple-mode repos only human comments with text and mentions of me stay shown; everything else
 * is hidden. Events by me are never new, except mentions of me.
 */
export function classify(events: Event[], ctx: ClassifyContext): ViewEvent[] {
  return events.map((e) => {
    const v: ViewEvent = {
      ...e,
      ...classifyOne(e, ctx),
      // A MentionedEvent's actor is the mentioned user, so it is exempt from the "by me" rule.
      // Undated events carry the fetch time, so comparing it with the last visit means nothing.
      isNew:
        e.undated !== true &&
        (ctx.dismissedAt === null || isAfter(e.at, ctx.dismissedAt)) &&
        (e.kind === "mentioned" || !isMe(e.actor?.login, ctx.me)),
    };
    if (ctx.mode === "simple") {
      const keep =
        v.level === "show" &&
        ((isHumanText(v) && (v.body ?? "").trim() !== "") ||
          (v.kind === "mentioned" && isMe(v.data.target, ctx.me)));
      if (!keep) v.level = "hidden";
    }
    return v;
  });
}
