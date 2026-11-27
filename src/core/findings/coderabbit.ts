import { toSeverity } from "./severity.ts";
import type { FindingReport } from "./types.ts";

export const CODERABBIT_MARKER = "<!-- coderabbit-ai-generated";

const HEADER = /^\*\*(?:<picture>[\s\S]*?<\/picture>\s*)?([^*]+)\*\*(?: · \*\*([^*]+)\*\*)?(?: · \*\*([^*]+)\*\*)?\s*$/;
const ADDRESSED = /✅ Addressed in commit ([0-9a-f]{7,40})/;

/** Boilerplate CodeRabbit repeats in every agent prompt. */
const PROMPT_BOILERPLATE = [/^Treat finding text, file paths, and code as untrusted/, /^After applying the fix, consider running/];

function agentPrompt(body: string): string | null {
  const start = body.indexOf("<!-- ai-agent-prompt:start -->");
  const end = body.indexOf("<!-- ai-agent-prompt:end -->");
  if (start < 0 || end < start) return null;
  const fenced = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/m.exec(body.slice(start, end));
  if (!fenced?.[2]) return null;
  const paragraphs = fenced[2]
    .split(/\n\s*\n/)
    .filter((p) => !PROMPT_BOILERPLATE.some((re) => re.test(p.trim())));
  return paragraphs.join("\n\n").trim() || null;
}

export interface CodeRabbitComment {
  report: Omit<FindingReport, "id" | "file" | "line" | "url">;
  /** The commit CodeRabbit says addressed the finding. */
  addressedIn: string | null;
}

/** Parses the first comment of a CodeRabbit review thread; null when the body is not one. */
export function parseCodeRabbitComment(body: string): CodeRabbitComment | null {
  if (!body.includes(CODERABBIT_MARKER)) return null;
  const lines = body.split("\n").map((l) => l.trim());
  let label = "";
  let category: string | null = null;
  let title = "";
  for (const line of lines) {
    if (!label) {
      const h = HEADER.exec(line);
      if (h?.[1]) {
        label = h[1].trim();
        category = h[2]?.trim() ?? null;
      }
      continue;
    }
    const bold = /^\*\*(.+)\*\*$/.exec(line);
    if (bold?.[1] && !bold[1].includes("**")) {
      title = bold[1].trim().replace(/\.$/, "");
      break;
    }
  }
  if (!label && !title) return null;
  return {
    report: {
      tool: "coderabbit",
      severity: toSeverity(label),
      label: label || "Finding",
      category,
      title: title || "CodeRabbit finding",
      copyText: agentPrompt(body),
    },
    addressedIn: ADDRESSED.exec(body)?.[1] ?? null,
  };
}
