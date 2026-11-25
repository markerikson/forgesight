import type { LlmUsage } from "../core/summaries/cost.ts";
import type { OutputSchema } from "../core/summaries/schema.ts";

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  /** The output arrives as the input of this forced tool call. */
  schema: OutputSchema;
  maxTokens: number;
}

export interface LlmResult {
  /** The tool input as received, not validated yet. */
  output: unknown;
  usage: LlmUsage;
  model: string;
  durationMs: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
}

export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    message: string,
    readonly status: number | null,
    /** Worth retrying later: rate limits, overload, server errors, network failures. */
    readonly retryable: boolean,
    /** Tokens billed before the failure, when the response reported them. */
    readonly usage: LlmUsage | null = null,
  ) {
    super(message);
  }
}
