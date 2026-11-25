import { describe, expect, test } from "bun:test";
import { OUTPUT_SCHEMAS } from "../core/summaries/schema.ts";
import { fakeText } from "@tanstack/ai/testing";
import { type FetchFn, llmClientFor } from "./client.ts";
import { createTanstackClient, isRetryable, toLlmUsage } from "./tanstack.ts";
import { LlmError, type LlmRequest } from "./types.ts";
import { parseWorkstreamSummary } from "./validate.ts";

const request: LlmRequest = {
  model: "claude-haiku-4-5",
  system: "system prompt",
  user: "user prompt",
  schema: OUTPUT_SCHEMAS.workstream_summary,
  maxTokens: 400,
};

describe("createTanstackClient", () => {
  test("returns the structured output, usage and model", async () => {
    const adapter = fakeText({ model: "claude-haiku-4-5" });
    adapter.setResponses([{ text: JSON.stringify({ name: "Auth rewrite", summary: "Rewrites auth." }) }]);
    let t = 1000;
    const client = createTanstackClient(() => adapter, () => (t += 250));
    const result = await client.complete(request);
    expect(result.output).toEqual({ name: "Auth rewrite", summary: "Rewrites auth." });
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.durationMs).toBe(250);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.output).toBeGreaterThan(0);
    expect(adapter.state.callCount).toBe(1);
  });

  test("a failed run becomes an LlmError", async () => {
    const adapter = fakeText();
    adapter.setResponses([{ error: "boom" }]);
    const e = (await createTanstackClient(() => adapter)
      .complete(request)
      .catch((x: unknown) => x)) as LlmError;
    expect(e).toBeInstanceOf(LlmError);
    expect(e.message).toContain("boom");
    expect(e.retryable).toBe(true);
  });

  test("usage keeps cache reads and writes apart from plain input", () => {
    expect(
      toLlmUsage({
        promptTokens: 1000,
        completionTokens: 50,
        totalTokens: 1050,
        promptTokensDetails: { cachedTokens: 600, cacheWriteTokens: 100 },
      }),
    ).toEqual({ input: 300, output: 50, cacheRead: 600, cacheWrite: 100 });
    expect(toLlmUsage({ promptTokens: 10, completionTokens: 2, totalTokens: 12 })).toEqual({
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("rate limits, overload and server errors are retryable, other 4xx and truncation are not", () => {
    expect(isRetryable("429")).toBe(true);
    expect(isRetryable("529")).toBe(true);
    expect(isRetryable("500")).toBe(true);
    expect(isRetryable("400")).toBe(false);
    expect(isRetryable("401")).toBe(false);
    expect(isRetryable("max_tokens")).toBe(false);
    expect(isRetryable(undefined)).toBe(true);
  });
});

interface Seen {
  url: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(status: number, body: string, seen: Seen[], contentType = "application/json"): FetchFn {
  return async (input, init) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, headers: req.headers, body: await req.json() });
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

describe("llmClientFor", () => {
  const task = { provider: "anthropic", model: "claude-haiku-4-5" } as const;
  const env = { ANTHROPIC_API_KEY: "sk-env" };

  test("null without an API key", () => {
    expect(llmClientFor(task, {})).toBeNull();
    expect(llmClientFor(task, { ANTHROPIC_API_KEY: "  " })).toBeNull();
  });

  test("an unknown model fails at startup", () => {
    expect(() => llmClientFor({ ...task, model: "claude-nope" }, env)).toThrow(/Unknown Anthropic model/);
  });

  test("calls the Anthropic API with the key, base URL and request", async () => {
    const seen: Seen[] = [];
    const answer = JSON.stringify({ name: "Auth rewrite", summary: "Rewrites auth." });
    const body = sse([
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5-20251001",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      ],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]);
    const client = llmClientFor(
      { ...task, baseUrl: "http://localhost:9999" },
      env,
      fakeFetch(200, body, seen, "text/event-stream"),
    );
    const result = await client!.complete(request);
    expect(result.output).toEqual({ name: "Auth rewrite", summary: "Rewrites auth." });
    expect(result.usage).toEqual({ input: 1200, output: 80, cacheRead: 0, cacheWrite: 0 });

    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).pathname).toBe("/v1/messages");
    expect(new URL(seen[0]!.url).host).toBe("localhost:9999");
    expect(seen[0]!.headers.get("x-api-key")).toBe("sk-env");
    expect(seen[0]!.body).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 400 });
    expect(JSON.stringify(seen[0]!.body)).toContain("system prompt");
    expect(JSON.stringify(seen[0]!.body)).toContain("user prompt");
  });

  test("HTTP errors carry the status, and only rate limits and overload retry", async () => {
    const err = async (status: number) => {
      const client = llmClientFor(
        task,
        env,
        fakeFetch(status, JSON.stringify({ type: "error", error: { type: "some_error", message: "nope" } }), []),
      );
      return (await client!.complete(request).catch((x: unknown) => x)) as LlmError;
    };
    const rateLimited = await err(429);
    expect(rateLimited).toBeInstanceOf(LlmError);
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.retryable).toBe(true);
    expect((await err(529)).retryable).toBe(true);
    expect((await err(400)).retryable).toBe(false);
  });
});

describe("parseWorkstreamSummary", () => {
  test("trims fields and drops an empty status", () => {
    expect(parseWorkstreamSummary({ name: " Auth rewrite. ", summary: " Does things. ", status: " " })).toEqual({
      name: "Auth rewrite",
      summary: "Does things.",
    });
    expect(parseWorkstreamSummary({ name: "X", summary: "Y", status: "Merged" })).toEqual({
      name: "X",
      summary: "Y",
      status: "Merged",
    });
  });
  test("rejects missing or empty fields", () => {
    expect(parseWorkstreamSummary({ name: "X" })).toHaveProperty("error");
    expect(parseWorkstreamSummary({ name: "", summary: "Y" })).toHaveProperty("error");
    expect(parseWorkstreamSummary("nope")).toHaveProperty("error");
    expect(parseWorkstreamSummary({ name: "...", summary: "Y" })).toHaveProperty("error");
    expect(parseWorkstreamSummary({ name: "X", summary: "  " })).toHaveProperty("error");
  });
});
