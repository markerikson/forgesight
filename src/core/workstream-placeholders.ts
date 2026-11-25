// PLACEHOLDER: replaced by m4-llm branch at merge (latest summary per workstream id).
export interface WorkstreamSummaryRecord {
  /** Suggested name from the summary prompt. */
  name: string | null;
  text: string;
  status: string | null;
  generatedAt: string;
  hash: string;
}
