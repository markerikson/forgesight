/** Structured output for a workstream summary. */
export interface WorkstreamSummaryOutput {
  /** Short name suggestion, a few words. A manual rename wins over it. */
  name: string;
  /** Two or three sentences: what the work does, why, and its scope. */
  summary: string;
  /** One line, only when the workstream is closed or looks tabled. */
  status?: string;
}

export const WORKSTREAM_SUMMARY_SCHEMA = "workstream_summary";

export type SchemaName = typeof WORKSTREAM_SUMMARY_SCHEMA;

export interface OutputSchema {
  name: SchemaName;
  description: string;
  /** JSON Schema for the forced tool call that carries the output. */
  inputSchema: Record<string, unknown>;
}

export const OUTPUT_SCHEMAS: Record<SchemaName, OutputSchema> = {
  [WORKSTREAM_SUMMARY_SCHEMA]: {
    name: WORKSTREAM_SUMMARY_SCHEMA,
    description: "Record the summary of a workstream of related pull requests.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short name for the workstream, 2 to 6 words, no trailing punctuation.",
        },
        summary: {
          type: "string",
          description: "2 to 3 plain sentences: what the work changes, why, and how far it reaches.",
        },
        status: {
          type: "string",
          description:
            "One short line on where the work stands. Only when the workstream is closed or looks tabled.",
        },
      },
      required: ["name", "summary"],
      additionalProperties: false,
    },
  },
};
