// The one place Argus talks to the Claude API (ESLint allows @anthropic-ai/sdk only in src/model/).
// Callers build a small provider-neutral ModelRequest; the cache stores the matching ModelResult.
//
// Clients:
// - AnthropicModelClient: the real API. Reads ANTHROPIC_API_KEY on the server when it first calls.
// - ReplayModelClient: MODEL_MODE=replay. Never calls the API; callModel answers from model_cache
//   or throws ReplayMiss, so capture, CI, and e2e need no key.
// - FakeModelClient: scripted answers for unit tests only. No production path constructs it.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../argus.config.ts";

export interface ModelTextBlock {
  type: "text";
  text: string;
}

export interface ModelToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ModelToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ModelContentBlock = ModelTextBlock | ModelToolUseBlock | ModelToolResultBlock;

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ModelContentBlock[];
}

/** A strict tool: every object schema sets additionalProperties false. */
export interface ModelTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  maxTokens: number;
  tools?: ModelTool[];
  /** "auto" lets the model call tools; "none" forces a final answer. */
  toolChoice?: "auto" | "none";
  /** JSON schema for the answer text (structured outputs, output_config.format). */
  outputSchema?: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResult {
  model: string;
  content: Array<ModelTextBlock | ModelToolUseBlock>;
  stopReason: string | null;
  usage: ModelUsage;
}

export interface ModelClient {
  /** "replay" clients never answer: callModel serves the cache or throws ReplayMiss. */
  readonly mode: "live" | "replay" | "fake";
  create(request: ModelRequest): Promise<ModelResult>;
}

export class MissingApiKey extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set on the server");
    this.name = "MissingApiKey";
  }
}

export class ReplayMiss extends Error {
  readonly inputDigest: string;
  constructor(inputDigest: string) {
    super(`Replay mode has no recorded model output for input ${inputDigest}`);
    this.name = "ReplayMiss";
    this.inputDigest = inputDigest;
  }
}

/** The API answered with an error or could not be reached. */
export class ModelApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ModelApiError";
    this.status = status;
  }
}

function toSdkContent(block: ModelContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
  }
}

function toSdkMessage(m: ModelMessage): Anthropic.MessageParam {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  // The API rejects empty text blocks, which an answer made only of tool calls can carry.
  const blocks = m.content.filter((b) => b.type !== "text" || b.text.length > 0);
  return { role: m.role, content: blocks.map(toSdkContent) };
}

function fromSdkMessage(res: Anthropic.Message): ModelResult {
  const content: ModelResult["content"] = [];
  for (const block of res.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
  }
  const u = res.usage;
  return {
    model: res.model,
    content,
    stopReason: res.stop_reason,
    usage: {
      // Prompt caching never applies here (Haiku 4.5 needs a 4,096-token prefix), but count any
      // cache tokens as input so the spend cap can only overestimate.
      inputTokens:
        u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    },
  };
}

/** The real Claude API. The key is read on the first call, on the server only. */
export class AnthropicModelClient implements ModelClient {
  readonly mode = "live";
  #sdk: Anthropic | null = null;

  async create(request: ModelRequest): Promise<ModelResult> {
    if (!this.#sdk) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new MissingApiKey();
      this.#sdk = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    }
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: config.model.id,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages.map(toSdkMessage),
    };
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => ({ ...t, strict: true }));
      params.tool_choice = { type: request.toolChoice ?? "auto" };
    }
    if (request.outputSchema) {
      params.output_config = { format: { type: "json_schema", schema: request.outputSchema } };
    }
    try {
      return fromSdkMessage(await this.#sdk.messages.create(params));
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new ModelApiError(`Claude API error: ${err.message}`, err.status ?? null);
      }
      throw err;
    }
  }
}

/** MODEL_MODE=replay: never calls the API. callModel checks the cache before it gets here. */
export class ReplayModelClient implements ModelClient {
  readonly mode = "replay";

  async create(): Promise<ModelResult> {
    throw new ReplayMiss("unknown");
  }
}

type ScriptStep = ModelResult | ((request: ModelRequest) => ModelResult | Promise<ModelResult>);

/** Scripted answers, in order, for unit tests. Records every request it receives. */
export class FakeModelClient implements ModelClient {
  readonly mode = "fake";
  readonly calls: ModelRequest[] = [];
  readonly #script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.#script = [...script];
  }

  async create(request: ModelRequest): Promise<ModelResult> {
    this.calls.push(request);
    const step = this.#script.shift();
    if (!step) throw new Error(`FakeModelClient has no answer for call ${this.calls.length}`);
    return typeof step === "function" ? step(request) : step;
  }
}

const DEFAULT_USAGE: ModelUsage = { inputTokens: 1000, outputTokens: 200 };

/** A text answer (tests and recorded fixtures). */
export function textResult(text: string, usage: ModelUsage = DEFAULT_USAGE): ModelResult {
  return {
    model: config.model.id,
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage,
  };
}

/** An answer that calls tools (tests and recorded fixtures). */
export function toolUseResult(
  calls: Array<{ id: string; name: string; input: unknown }>,
  usage: ModelUsage = DEFAULT_USAGE,
): ModelResult {
  return {
    model: config.model.id,
    content: calls.map((c) => ({ type: "tool_use", ...c })),
    stopReason: "tool_use",
    usage,
  };
}

export function modelMode(
  env: Record<string, string | undefined> = process.env,
): "live" | "replay" {
  return env.MODEL_MODE === "replay" ? "replay" : "live";
}

/** The client for route handlers: replay or the real API. Never the fake. */
export function createModelClient(
  env: Record<string, string | undefined> = process.env,
): ModelClient {
  return modelMode(env) === "replay" ? new ReplayModelClient() : new AnthropicModelClient();
}
