import type { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { describe } from "../core/pipeline/index.ts";
import type { InboxRow, Round, SubjectView } from "../core/pipeline/types.ts";
import type { ThreadRecord } from "../core/types.ts";
import { hourlySpendSince } from "../store/api-calls.ts";
import { defaultDbPath, openDb } from "../store/db.ts";
import { getSubject } from "../store/subjects.ts";
import { listThreads, threadsForSubject } from "../store/threads.ts";
import { reviewThreadsFor, stickiesFor, timelineCounts, timelineFor } from "../store/timeline.ts";
import { getView, listViews } from "../store/views.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function path(value: unknown, ...keys: string[]): unknown {
  let cur = value;
  for (const k of keys) cur = obj(cur)?.[k];
  return cur;
}

function titleOf(subjectRaw: unknown, thread: ThreadRecord | undefined): string {
  return str(path(subjectRaw, "title")) ?? str(path(thread?.raw, "subject", "title")) ?? "";
}

function firstLine(text: string, max = 100): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Who did a timeline item, whatever its type. */
export function itemActor(raw: unknown): string {
  return (
    str(path(raw, "author", "login")) ??
    str(path(raw, "actor", "login")) ??
    str(path(raw, "commit", "author", "user", "login")) ??
    str(path(raw, "commit", "author", "name")) ??
    "-"
  );
}

/** A one-line description of a timeline item: its body, commit message, label or state. */
export function itemText(raw: unknown): string {
  const text =
    str(path(raw, "body")) ??
    str(path(raw, "commit", "messageHeadline")) ??
    str(path(raw, "commit", "message")) ??
    str(path(raw, "label", "name")) ??
    str(path(raw, "requestedReviewer", "login")) ??
    str(path(raw, "state")) ??
    "";
  return firstLine(text);
}

function countsText(counts: Map<string, number> | undefined): string {
  if (!counts || counts.size === 0) return "no timeline";
  return [...counts].map(([type, n]) => `${type} ${n}`).join(", ");
}

/** Subjects of threads updated in the last 24 hours, newest first. */
export function recentSummary(db: Database, now: Date): string[] {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const threads = listThreads(db, { since });
  const seen = new Set<string>();
  const latest: ThreadRecord[] = [];
  for (const t of threads) {
    if (seen.has(t.subjectKey)) continue;
    seen.add(t.subjectKey);
    latest.push(t);
  }
  const counts = timelineCounts(
    db,
    latest.map((t) => t.subjectKey),
  );
  const lines = [`${latest.length} subjects with threads updated since ${since}`];
  for (const t of latest) {
    const subject = getSubject(db, t.subjectKey);
    const status = subject?.dirtyAt ? " [queued]" : subject?.enrichError ? ` [error: ${subject.enrichError}]` : "";
    lines.push(`${t.subjectKey}  ${t.reason}  ${titleOf(subject?.raw, t)}${status}`);
    lines.push(`    ${t.updatedAt}  ${countsText(counts.get(t.subjectKey))}`);
  }
  return lines;
}

/** Everything stored for one subject. */
export function subjectDetail(db: Database, key: string): string[] {
  const subject = getSubject(db, key);
  if (!subject) return [`No subject ${key}`];
  const { raw, ...columns } = subject;
  const threads = threadsForSubject(db, key);
  const lines = [`${key}  ${titleOf(raw, threads[0])}`];
  for (const [name, value] of Object.entries(columns)) lines.push(`  ${name}: ${value ?? "-"}`);

  lines.push("", `threads (${threads.length})`);
  for (const t of threads) {
    lines.push(`  ${t.threadId}  ${t.reason}  updated ${t.updatedAt}  ${t.unread ? "unread" : "read"}`);
  }

  const items = timelineFor(db, key);
  lines.push("", `timeline (${items.length})`);
  for (const item of items) {
    lines.push(`  ${item.createdAt}  ${item.typename}  ${itemActor(item.raw)}  ${itemText(item.raw)}`);
  }

  const reviewThreads = reviewThreadsFor(db, key);
  lines.push("", `review threads (${reviewThreads.length})`);
  for (const rt of reviewThreads) {
    const flags = [rt.isResolved ? "resolved" : "open", rt.isOutdated ? "outdated" : null].filter(Boolean).join(", ");
    lines.push(`  ${rt.path ?? "-"}:${rt.line ?? "-"}  ${flags}`);
  }

  const stickies = stickiesFor(db, key);
  lines.push("", `sticky versions (${stickies.length})`);
  for (const s of stickies) {
    lines.push(`  ${s.commentNodeId}  ${s.author}  seen ${s.seenAt} .. ${s.lastSeenAt}  ${firstLine(s.body)}`);
  }
  return lines;
}

function roundLines(round: Round): string[] {
  const head = `  ${round.startedAt}  ${round.startLabel ?? "(start)"}${round.isNew ? "  NEW" : ""}`;
  const lines = [round.hiddenCount > 0 ? `${head}  (+${round.hiddenCount} hidden)` : head];
  for (const entry of round.entries) {
    if (entry.type === "group") {
      lines.push(`    [${entry.group.summary}]${entry.group.isNew ? " new" : ""}`);
      continue;
    }
    const e = entry.event;
    const rule = e.ruleId ? ` (${e.ruleId})` : "";
    lines.push(`    ${e.at}  ${describe(e)}${rule}${e.isNew ? "  new" : ""}`);
  }
  return lines;
}

/** The derived view for one subject, as the inbox would show it. */
export function viewDetail(db: Database, key: string): string[] {
  const record = getView(db, key);
  if (!record) return [`No view for ${key}`];
  const view = record.detail as unknown as SubjectView;
  const lines = [
    `${key}  ${view.header.title}`,
    `  section: ${view.section}  reasons: ${view.reasons.join(", ") || "-"}`,
    `  summary: ${view.summaryLine ?? "-"}`,
    `  new: ${view.newMeaningfulCount}  hidden stats: ${JSON.stringify(view.hiddenStats)}`,
    `  computed ${record.computedAt} (pipeline ${record.pipelineVersion})`,
  ];
  for (const link of view.links) lines.push(`  link ${link.label}: ${link.url}`);
  lines.push("", `rounds (${view.rounds.length}, newest first)`);
  for (const round of view.rounds) lines.push(...roundLines(round));
  return lines;
}

/** Section counts and the newest rows in each section. */
export function viewsSummary(db: Database, perSection = 10): string[] {
  const views = listViews(db, { includeHidden: true });
  const bySection = new Map<string, typeof views>();
  for (const v of views) bySection.set(v.section, [...(bySection.get(v.section) ?? []), v]);
  const lines: string[] = [];
  for (const [section, rows] of bySection) {
    lines.push(`${section} (${rows.length})`);
    for (const v of rows.slice(0, perSection)) {
      const row = v.row as unknown as InboxRow;
      lines.push(`  ${v.subjectKey}  [${row.reasons.join(",")}]  ${row.summaryLine ?? "-"}`);
    }
  }
  return lines.length > 0 ? lines : ["No views"];
}

/** API spend per hour, resource and work class over the last 24 hours. */
export function budgetSummary(db: Database, now: Date): string[] {
  const rows = hourlySpendSince(db, new Date(now.getTime() - DAY_MS).toISOString());
  if (rows.length === 0) return ["No API calls in the last 24 hours"];
  const lines = ["hour (UTC)     resource  class          calls   cost"];
  const totals = new Map<string, { calls: number; cost: number }>();
  for (const r of rows) {
    lines.push(
      `${r.hour}  ${r.resource.padEnd(8)}  ${r.workClass.padEnd(13)}  ${String(r.calls).padStart(5)}  ${String(r.cost).padStart(5)}`,
    );
    const key = `${r.resource} ${r.workClass}`;
    const total = totals.get(key) ?? { calls: 0, cost: 0 };
    total.calls += r.calls;
    total.cost += r.cost;
    totals.set(key, total);
  }
  lines.push("", "24h totals (GraphQL: points; REST: calls)");
  for (const [key, t] of totals) {
    lines.push(`  ${key.padEnd(24)}  ${String(t.calls).padStart(5)} calls  ${String(t.cost).padStart(6)} pts`);
  }
  return lines;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      budget: { type: "boolean", default: false },
      view: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const db = openDb(defaultDbPath(), { readonly: true });
  const now = new Date();
  const [key] = positionals;
  const lines = values.budget
    ? budgetSummary(db, now)
    : values.view
      ? key
        ? viewDetail(db, key)
        : viewsSummary(db)
      : key
        ? subjectDetail(db, key)
        : recentSummary(db, now);
  console.log(lines.join("\n"));
  db.close();
}
