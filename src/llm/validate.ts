import { type } from "arktype";
import type { WorkstreamSummaryOutput } from "../core/summaries/schema.ts";

const workstreamSummary = type({
  name: "string > 0",
  summary: "string > 0",
  "status?": "string",
});

/** Validates and tidies model output. Returns an error message instead of throwing. */
export function parseWorkstreamSummary(raw: unknown): WorkstreamSummaryOutput | { error: string } {
  const out = workstreamSummary(raw);
  if (out instanceof type.errors) return { error: `Invalid workstream summary: ${out.summary}` };
  const result: WorkstreamSummaryOutput = {
    name: out.name.trim().replace(/[.\s]+$/, ""),
    summary: out.summary.trim(),
  };
  const status = out.status?.trim();
  if (status) result.status = status;
  return result;
}
