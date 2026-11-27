import type { ReviewThreadRecord, StickyCommentVersion } from "../types.ts";
import { CODERABBIT_MARKER, parseCodeRabbitComment } from "./coderabbit.ts";
import { type DiffLoupeRun, parseDiffLoupeInline, parseDiffLoupeSticky } from "./diffloupe.ts";
import { isSerious, severityWeight, worstSeverity } from "./severity.ts";
import type { Finding, FindingIcon, FindingReport, FindingStatus, FindingTool } from "./types.ts";

/** One head change after a review, oldest first. */
export interface PushStep {
  before: string | null;
  after: string | null;
  /** A rebase or no-op push: the PR's own changes are the same. */
  restack: boolean;
}

export interface DeriveFindingsInput {
  headSha: string | null;
  stickies: readonly StickyCommentVersion[];
  reviewThreads: readonly ReviewThreadRecord[];
  pushes: readonly PushStep[];
  /** Findings first reported after this are new; null means everything is. */
  since: string | null;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Whether `head` is `reviewed`, or reached from it only through rebase or no-op pushes. */
export function sameChanges(reviewed: string | null, head: string | null, pushes: readonly PushStep[]): boolean {
  if (!reviewed || !head) return false;
  let cur = reviewed;
  for (const p of pushes) {
    if (cur === head) return true;
    if (p.before !== cur || !p.after) continue;
    if (!p.restack) return false;
    cur = p.after;
  }
  return cur === head;
}

interface TimedRun extends DiffLoupeRun {
  at: string;
}

function diffLoupeRuns(stickies: readonly StickyCommentVersion[]): TimedRun[] {
  const runs: TimedRun[] = [];
  for (const v of stickies) {
    const run = parseDiffLoupeSticky(v.body);
    if (run) runs.push({ ...run, at: v.lastEditedAt ?? v.seenAt });
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at));
}

function short(sha: string): string {
  return sha.slice(0, 10);
}

interface Built {
  report: FindingReport;
  status: FindingStatus;
  firstSeenAt: string;
  note: string | null;
}

function fromStickies(input: DeriveFindingsInput): Built[] {
  const runs = diffLoupeRuns(input.stickies);
  const latest = runs.at(-1);
  if (!latest) return [];
  const firstSeen = new Map<string, string>();
  const lastReport = new Map<string, FindingReport>();
  for (const run of runs) {
    for (const f of run.findings) {
      if (!firstSeen.has(f.id)) firstSeen.set(f.id, run.at);
      if (!run.stoppedAt || !lastReport.has(f.id)) lastReport.set(f.id, f);
    }
  }
  const current = sameChanges(latest.headSha, input.headSha, input.pushes);
  const staleNote = latest.stoppedAt ? `reviews stopped at ${short(latest.stoppedAt)}` : null;
  const inLatest = new Set(latest.findings.map((f) => f.id));
  const out: Built[] = [];
  for (const f of latest.findings) {
    out.push({
      report: f,
      status: current ? "outstanding" : "stale",
      firstSeenAt: firstSeen.get(f.id) ?? latest.at,
      note: current ? null : staleNote,
    });
  }
  for (const [id, f] of lastReport) {
    if (inLatest.has(id)) continue;
    out.push({ report: f, status: "fixed", firstSeenAt: firstSeen.get(id) ?? latest.at, note: null });
  }
  return out;
}

function firstComment(raw: unknown): Record<string, unknown> {
  const nodes = obj(obj(raw).comments).nodes;
  return Array.isArray(nodes) ? obj(nodes[0]) : {};
}

function threadStatus(t: ReviewThreadRecord, addressedIn: string | null): FindingStatus {
  if (addressedIn) return "fixed";
  if (t.isResolved) return "resolved";
  return t.isOutdated ? "stale" : "outstanding";
}

function fromThreads(input: DeriveFindingsInput): Built[] {
  const out: Built[] = [];
  for (const t of input.reviewThreads) {
    const first = firstComment(t.raw);
    const body = str(first.body);
    if (!body) continue;
    const createdAt = str(first.createdAt) ?? t.fetchedAt;
    const url = str(first.url);
    const base = { file: t.path, line: t.line, url };
    if (body.includes(CODERABBIT_MARKER)) {
      const parsed = parseCodeRabbitComment(body);
      if (!parsed) continue;
      out.push({
        report: { ...parsed.report, ...base, id: t.nodeId },
        status: threadStatus(t, parsed.addressedIn),
        firstSeenAt: createdAt,
        note: parsed.addressedIn ? `addressed in ${short(parsed.addressedIn)}` : null,
      });
      continue;
    }
    const inline = parseDiffLoupeInline(body, url);
    if (inline) {
      out.push({
        report: { ...inline, file: inline.file ?? t.path, line: inline.line ?? t.line },
        status: threadStatus(t, null),
        firstSeenAt: createdAt,
        note: null,
      });
    }
  }
  return out;
}

const STATUS_ORDER: Record<FindingStatus, number> = { outstanding: 0, stale: 1, fixed: 2, resolved: 3 };
const TOOL_ORDER: Record<FindingTool, number> = { diffloupe: 0, coderabbit: 1 };

function compareFindings(a: Finding, b: Finding): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    severityWeight(b.severity) - severityWeight(a.severity) ||
    TOOL_ORDER[a.tool] - TOOL_ORDER[b.tool] ||
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

/** Every DiffLoupe and CodeRabbit finding on a PR, with its current status. */
export function deriveFindings(input: DeriveFindingsInput): Finding[] {
  const summary = fromStickies(input);
  const ids = new Set(summary.map((b) => `${b.report.tool}:${b.report.id}`));
  const threads = fromThreads(input).filter((b) => !ids.has(`${b.report.tool}:${b.report.id}`));
  return [...summary, ...threads]
    .map(
      (b): Finding =>
        Object.assign({}, b.report, {
          status: b.status,
          firstSeenAt: b.firstSeenAt,
          isNew: input.since === null || b.firstSeenAt > input.since,
          serious: isSerious(b.report.severity),
          note: b.note,
        }),
    )
    .sort(compareFindings);
}

/** One row icon per tool that has outstanding or stale findings. */
export function findingIcons(findings: readonly Finding[]): FindingIcon[] {
  const out: FindingIcon[] = [];
  for (const tool of ["diffloupe", "coderabbit"] as const) {
    const open = findings.filter((f) => f.tool === tool && f.status === "outstanding");
    const stale = findings.filter((f) => f.tool === tool && f.status === "stale");
    if (open.length === 0 && stale.length === 0) continue;
    out.push({
      tool,
      outstanding: open.length,
      stale: stale.length,
      worst: worstSeverity((open.length > 0 ? open : stale).map((f) => f.severity)),
    });
  }
  return out;
}

/** Adds up row icons per tool, for a workstream row that stands for several PRs. */
export function sumFindingIcons(lists: readonly (readonly FindingIcon[])[]): FindingIcon[] {
  const out: FindingIcon[] = [];
  for (const tool of ["diffloupe", "coderabbit"] as const) {
    const icons = lists.flat().filter((i) => i.tool === tool);
    if (icons.length === 0) continue;
    const outstanding = icons.reduce((n, i) => n + i.outstanding, 0);
    const counted = outstanding > 0 ? icons.filter((i) => i.outstanding > 0) : icons;
    out.push({
      tool,
      outstanding,
      stale: icons.reduce((n, i) => n + i.stale, 0),
      worst: worstSeverity(counted.map((i) => i.worst)),
    });
  }
  return out;
}
