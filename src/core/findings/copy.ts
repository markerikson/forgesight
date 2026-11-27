import type { Finding, FindingTool } from "./types.ts";

export interface CopyInput {
  repo: string;
  number: number | null;
  title: string;
  findings: readonly Finding[];
  includeStale: boolean;
}

const TOOL_NAMES: Record<FindingTool, string> = { diffloupe: "DiffLoupe", coderabbit: "CodeRabbit" };

function where(f: Finding): string {
  if (!f.file) return "";
  return f.line !== null ? `${f.file}:${f.line}` : f.file;
}

/** Markdown for one finding: the bot's own agent-ready text when it has one. */
export function buildFindingCopy(f: Finding): string {
  if (f.tool === "diffloupe" && f.copyText) return f.copyText;
  const loc = where(f);
  const meta = [loc ? `\`${loc}\`` : null, f.url].filter((s) => s !== null).join(" · ");
  const parts = [`### [${f.severity}] ${f.title}`];
  if (meta) parts.push(meta);
  if (f.copyText) parts.push(f.copyText);
  return parts.join("\n\n");
}

export function copyableFindings(findings: readonly Finding[], includeStale: boolean): Finding[] {
  return findings.filter((f) => f.status === "outstanding" || (includeStale && f.status === "stale"));
}

/** Markdown to hand an agent; empty when there is nothing to copy. */
export function buildCopyMarkdown(input: CopyInput): string {
  const outstanding = input.findings.filter((f) => f.status === "outstanding");
  const stale = input.includeStale ? input.findings.filter((f) => f.status === "stale") : [];
  if (outstanding.length === 0 && stale.length === 0) return "";
  const ref = input.number !== null ? `${input.repo}#${input.number}` : input.repo;
  const out = [`# Findings: ${ref} ${input.title}`.trimEnd()];
  for (const tool of ["diffloupe", "coderabbit"] as const) {
    const list = outstanding.filter((f) => f.tool === tool);
    if (list.length === 0) continue;
    out.push(`## ${TOOL_NAMES[tool]}`, ...list.map(buildFindingCopy));
  }
  if (stale.length > 0) {
    out.push(
      "## Stale (may already be fixed)",
      "These were reported against an older commit. Check whether each still applies before changing anything.",
      ...stale.map((f) => {
        const body = buildFindingCopy(f);
        return f.note ? `${body}\n\n_${TOOL_NAMES[f.tool]}: ${f.note}_` : `${body}\n\n_${TOOL_NAMES[f.tool]}_`;
      }),
    );
  }
  return `${out.join("\n\n")}\n`;
}
