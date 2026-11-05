// Model cost in micro-dollars (1 USD = 1,000,000 micros), from the prices in argus.config.ts.
// A price of $N per million tokens is exactly N micros per token, so costs stay integers.
import { config } from "../../argus.config.ts";

export const MICROS_PER_USD = 1_000_000;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Tokens the API adds around the request that its JSON does not show: role markers and, when
 * tools are present, the tool-use system prompt (346 tokens on Haiku 4.5 per the docs), rounded up.
 */
const FRAMING_TOKENS = 100;
const TOOL_PROMPT_TOKENS = 600;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

/** What a call with this usage costs, rounded up to a whole micro-dollar. */
export function costMicros(usage: TokenUsage, prices = config.model): number {
  return Math.ceil(
    usage.inputTokens * prices.usdPerMillionInputTokens +
      usage.outputTokens * prices.usdPerMillionOutputTokens,
  );
}

/**
 * An upper bound on input tokens: every token covers at least one byte of text, so the UTF-8
 * size of the request JSON (which also counts quotes and braces the prompt never shows) plus the
 * framing above cannot be exceeded.
 */
export function estimateInputTokens(request: {
  system: string;
  messages: unknown;
  tools?: unknown;
  outputSchema?: unknown;
}): number {
  const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  return bytes + FRAMING_TOKENS + (request.tools ? TOOL_PROMPT_TOKENS : 0);
}

/** The most a request can cost: the input bound plus max_tokens of output. */
export function worstCaseMicros(request: {
  system: string;
  messages: unknown;
  tools?: unknown;
  outputSchema?: unknown;
  maxTokens: number;
}): number {
  return costMicros({ inputTokens: estimateInputTokens(request), outputTokens: request.maxTokens });
}
