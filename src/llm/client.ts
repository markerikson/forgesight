import { ANTHROPIC_MODELS, type AnthropicChatModel, createAnthropicChat } from "@tanstack/ai-anthropic";
import type { LlmTaskConfig } from "../core/config.ts";
import { createTanstackClient } from "./tanstack.ts";
import type { LlmClient } from "./types.ts";

export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

const TIMEOUT_MS = 60_000;

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isAnthropicModel(model: string): model is AnthropicChatModel {
  return (ANTHROPIC_MODELS as readonly string[]).includes(model);
}

/**
 * Client for one task, or `null` when the provider's key is not set. Keys come from the
 * environment only, so `config.jsonc` never holds secrets. Throws for a model the
 * provider adapter does not know.
 */
export function llmClientFor(
  task: LlmTaskConfig,
  env: Record<string, string | undefined> = process.env,
  fetch?: FetchFn,
): LlmClient | null {
  switch (task.provider) {
    case "anthropic": {
      const model = task.model;
      if (!isAnthropicModel(model)) {
        throw new Error(`Unknown Anthropic model "${model}". Known models: ${ANTHROPIC_MODELS.join(", ")}`);
      }
      const apiKey = env[ANTHROPIC_API_KEY_ENV]?.trim();
      if (!apiKey) return null;
      // The worker owns retries and backoff, so the SDK must not retry on its own.
      const options = {
        maxRetries: 0,
        timeout: TIMEOUT_MS,
        ...(task.baseUrl ? { baseURL: task.baseUrl } : {}),
        ...(fetch ? { fetch } : {}),
      };
      return createTanstackClient((requested) =>
        createAnthropicChat(isAnthropicModel(requested) ? requested : model, apiKey, options),
      );
    }
  }
}
