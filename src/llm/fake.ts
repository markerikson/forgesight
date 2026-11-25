import type { LlmUsage } from "../core/summaries/cost.ts";
import type { LlmClient, LlmRequest, LlmResult } from "./types.ts";

export type FakeLlmHandler = (req: LlmRequest) => unknown;

/** Test client: records requests and answers from a handler. A thrown error fails the call. */
export class FakeLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  usage: LlmUsage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };

  constructor(public handler: FakeLlmHandler = () => ({ name: "Fake workstream", summary: "Fake summary." })) {}

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(req);
    const output = this.handler(req);
    return { output, usage: { ...this.usage }, model: req.model, durationMs: 1 };
  }
}
