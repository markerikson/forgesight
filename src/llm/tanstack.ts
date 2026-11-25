import { type AnyTextAdapter, chat, EventType, type RunErrorEvent, type UsageInfo } from "@tanstack/ai";
import type { LlmUsage } from "../core/summaries/cost.ts";
import { type LlmClient, LlmError, type LlmRequest, type LlmResult } from "./types.ts";

/** Builds the TanStack AI adapter for one model. */
export type AdapterFor = (model: string) => AnyTextAdapter;

/**
 * TanStack AI reports `promptTokens` as the whole input, cache reads and writes
 * included. Our usage keeps them apart because they are priced differently.
 */
export function toLlmUsage(usage: UsageInfo): LlmUsage {
  const cacheRead = usage.promptTokensDetails?.cachedTokens ?? 0;
  const cacheWrite =
    (usage.promptTokensDetails?.cacheWriteTokens ?? 0) + (usage.promptTokensDetails?.cacheWrite1hTokens ?? 0);
  return {
    input: Math.max(0, usage.promptTokens - cacheRead - cacheWrite),
    output: usage.completionTokens,
    cacheRead,
    cacheWrite,
  };
}

function addUsage(a: LlmUsage | null, b: LlmUsage): LlmUsage {
  if (!a) return b;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * `code` is the HTTP status when the provider answered with one. Rate limits,
 * overload and server errors are worth retrying, other 4xx and a truncated answer
 * are not. Failures without a status (network errors, output that did not parse)
 * get retried; the worker caps the attempts.
 */
export function isRetryable(code: string | undefined): boolean {
  const status = code && /^\d{3}$/.test(code) ? Number(code) : null;
  if (status !== null) return status === 408 || status === 429 || status >= 500;
  return code !== "max_tokens";
}

function errorFromEvent(event: RunErrorEvent, usage: LlmUsage | null): LlmError {
  const code = event.code ?? event.error?.code;
  const status = code && /^\d{3}$/.test(code) ? Number(code) : null;
  const message = event.message || event.error?.message || "LLM call failed";
  return new LlmError(code ? `${code}: ${message}` : message, status, isRetryable(code), usage);
}

/**
 * `LlmClient` on top of TanStack AI's `chat()`. The provider is whatever adapter
 * `adapterFor` returns, so adding a provider does not touch this code.
 *
 * The output schema is plain JSON Schema, which TanStack AI passes to the model
 * without checking the answer; `src/llm/validate.ts` checks it.
 */
export function createTanstackClient(adapterFor: AdapterFor, now: () => number = Date.now): LlmClient {
  return {
    async complete(req: LlmRequest): Promise<LlmResult> {
      const started = now();
      let usage: LlmUsage | null = null;
      let output: unknown;
      let gotOutput = false;
      let model = req.model;

      try {
        const stream = chat({
          adapter: adapterFor(req.model),
          threadId: `forgesight-${req.schema.name}`,
          systemPrompts: [req.system],
          messages: [{ role: "user", content: req.user }],
          outputSchema: req.schema.inputSchema,
          stream: true,
          promptCache: "none",
          // Errors come back as LlmError and the worker logs them once.
          debug: false,
          modelOptions: { max_tokens: req.maxTokens },
          middleware: [
            {
              name: "forgesight-usage",
              onUsage: (_ctx, info) => {
                usage = addUsage(usage, toLlmUsage(info));
              },
            },
          ],
        });
        for await (const chunk of stream) {
          if (chunk.type === EventType.CUSTOM && chunk.name === "structured-output.complete") {
            output = (chunk.value as { object: unknown }).object;
            gotOutput = true;
          } else if (chunk.type === EventType.RUN_FINISHED) {
            model = chunk.model ?? chunk.metadata?.tanstack?.model ?? model;
          } else if (chunk.type === EventType.RUN_ERROR) {
            throw errorFromEvent(chunk, usage);
          }
        }
      } catch (err) {
        if (err instanceof LlmError) throw err;
        throw new LlmError(`LLM call failed: ${(err as Error).message}`, null, true, usage);
      }

      if (!gotOutput) throw new LlmError("LLM run finished without structured output", null, true, usage);
      return {
        output,
        usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        model,
        durationMs: now() - started,
      };
    },
  };
}
