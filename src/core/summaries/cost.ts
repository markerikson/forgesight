import type { ModelPrice } from "../config.ts";

export interface LlmUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Cost of one call in USD. `null` when the model has no price entry. */
export function costUsd(usage: LlmUsage, model: string, prices: Record<string, ModelPrice>): number | null {
  const price = prices[model];
  if (!price) return null;
  const micro =
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheRead * price.cacheRead +
    usage.cacheWrite * price.cacheWrite;
  return micro / 1_000_000;
}

/** Start of the UTC day containing `now`, as an ISO string. The daily cap resets here. */
export function utcDayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}
