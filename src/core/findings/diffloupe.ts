import { toSeverity } from "./severity.ts";
import type { FindingReport } from "./types.ts";

export interface DiffLoupeMarker {
  kind: string;
  fields: Record<string, string>;
}

const MARKER = /<!--\s*ai-review\s+([^>]*?)\s*-->/g;

export function parseMarkers(text: string): DiffLoupeMarker[] {
  const out: DiffLoupeMarker[] = [];
  for (const m of text.matchAll(MARKER)) {
    const fields: Record<string, string> = {};
    for (const part of (m[1] ?? "").split(/\s+/)) {
      const eq = part.indexOf("=");
      if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    if (fields.kind) out.push({ kind: fields.kind, fields });
  }
  return out;
}

/** One DiffLoupe review as its sticky summary comment reported it. */
export interface DiffLoupeRun {
  /** The commit the findings were reported against. */
  headSha: string | null;
  /** A newer commit DiffLoupe declined to review; the findings may be out of date. */
  stoppedAt: string | null;
  findings: FindingReport[];
}

const LABELS: Record<string, string> = {
  blocker: "Blocker",
  "should-fix": "Should fix",
  "nice-to-have": "Nice to have",
  question: "Question",
};

function toLine(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw && Number.isInteger(n) ? n : null;
}

function firstUrl(text: string): string | null {
  return /\]\((https?:\/\/[^)\s]+)\)/.exec(text)?.[1] ?? null;
}

function bulletTitle(text: string): string {
  let t = text.replace(/^\s*-\s+/, "");
  const labelled = /^\S*\s*\*\*[^*]+\*\*\s+(.*)$/.exec(t);
  if (labelled?.[1]) t = labelled[1];
  const cut = t.indexOf(" — [");
  if (cut >= 0) t = t.slice(0, cut);
  t = t.replace(/\s+·\s+_\[\d+\]_\s*$/, "");
  return t.replace(/^Still open:\s*/, "").trim();
}

/** Per-finding Markdown from the "Copy all findings" block, keyed by fingerprint. */
export function copySections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const start = body.indexOf("<!-- ai-review-copy -->");
  const end = body.indexOf("<!-- /ai-review-copy -->");
  if (start < 0 || end < start) return out;
  const block = body.slice(start, end);
  const open = /^```+markdown\s*$/m.exec(block);
  if (!open) return out;
  const fence = open[0].trim().replace(/markdown$/, "");
  const from = open.index + open[0].length;
  const close = block.lastIndexOf(`\n${fence}`);
  const inner = block.slice(from, close > from ? close : undefined);
  for (const part of inner.split(/\n(?=### \[)/).slice(1)) {
    const id = /· id `([0-9a-f]+)`/.exec(part)?.[1];
    if (id) out.set(id, part.trim());
  }
  return out;
}

/** Parses a DiffLoupe sticky summary comment; null when the body is not one. */
export function parseDiffLoupeSticky(body: string): DiffLoupeRun | null {
  const markers = parseMarkers(body);
  const summary = markers.find((m) => m.kind === "summary");
  if (!summary) return null;
  const stopped = markers.find((m) => m.kind === "stopped");
  const copies = copySections(body);
  const findings: FindingReport[] = [];
  const seen = new Set<string>();
  for (const line of body.split("\n")) {
    const [marker] = parseMarkers(line);
    if (marker?.kind !== "summary-item") continue;
    const f = marker.fields;
    const id = f.fp;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = line.slice(0, line.indexOf("<!--"));
    const severity = toSeverity(f.sev);
    findings.push({
      tool: "diffloupe",
      id,
      severity,
      label: LABELS[severity] ?? f.sev ?? "Finding",
      category: null,
      file: f.file ?? null,
      line: toLine(f.line),
      title: bulletTitle(text) || `${f.file ?? "finding"}:${f.line ?? ""}`,
      copyText: copies.get(id) ?? null,
      url: firstUrl(text),
    });
  }
  return {
    headSha: summary.fields.head ?? null,
    stoppedAt: stopped?.fields.head ?? null,
    findings,
  };
}

/** Parses a DiffLoupe inline review comment; null when the body is not one. */
export function parseDiffLoupeInline(body: string, url: string | null): FindingReport | null {
  const marker = parseMarkers(body).find((m) => m.kind === "inline");
  const id = marker?.fields.fp;
  if (!marker || !id) return null;
  const f = marker.fields;
  const severity = toSeverity(f.sev);
  const title = /^#{1,6}\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    tool: "diffloupe",
    id,
    severity,
    label: LABELS[severity] ?? f.sev ?? "Finding",
    category: null,
    file: f.file ?? null,
    line: toLine(f.line),
    title: title || `${f.file ?? "finding"}:${f.line ?? ""}`,
    copyText: body.replace(MARKER, "").trim(),
    url,
  };
}
