import Anthropic from "@anthropic-ai/sdk";

/** What the assistant needs from a language model. Small on purpose, so tests can script it. */
export type ToolSpec = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
};
export type ChatMessage = { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> };
export type LlmRequest = { system: string[]; tools: ToolSpec[]; messages: ChatMessage[] };
export type LlmUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type LlmResponse = {
  /** Content blocks exactly as returned; the caller sends them back unchanged on the next turn. */
  content: Array<Record<string, any>>;
  stopReason: string | null;
  usage: LlmUsage;
  model: string;
};
export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(readonly kind: "auth" | "rate_limit" | "overloaded" | "bad_request" | "timeout" | "other", message: string) {
    super(message);
  }
}

export type AnthropicLlmOptions = {
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Ask the API to re-run a request another model when a safety classifier declines it (Claude API only). */
  serverFallbacks?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a client that resolves credentials from the environment. */
  client?: Pick<Anthropic, "beta">;
};

export class AnthropicLlm implements LlmClient {
  readonly model: string;
  private client: Pick<Anthropic, "beta">;

  constructor(private opts: AnthropicLlmOptions) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic({ maxRetries: 2 });
  }

  async complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    try {
      const res = await this.client.beta.messages.create(
        {
          model: this.opts.model,
          max_tokens: this.opts.maxTokens ?? 16000,
          // Caches the stable prefix (tools, instructions, schema) and each turn's growing history within one question.
          cache_control: { type: "ephemeral" },
          system: req.system.map((text) => ({ type: "text" as const, text })),
          // strict: the API guarantees tool inputs match the schema. Tool use is left on "auto": forced tool_choice is rejected on current models.
          tools: req.tools.map((t) => ({ ...t, strict: true })),
          messages: req.messages as Anthropic.Beta.BetaMessageParam[],
          output_config: { effort: this.opts.effort ?? "medium" },
          ...(this.opts.serverFallbacks !== false ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal, timeout: this.opts.timeoutMs ?? 60_000 },
      );
      return {
        content: res.content as unknown as Array<Record<string, any>>,
        stopReason: res.stop_reason,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        },
        model: res.model,
      };
    } catch (err) {
      throw toLlmError(err);
    }
  }
}

/** Translate SDK exceptions into a small, safe vocabulary (never echo provider messages, which can contain request detail). */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("timeout", "the AI provider timed out");
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new LlmError("auth", "the AI provider rejected the server's credentials");
  if (err instanceof Anthropic.RateLimitError) return new LlmError("rate_limit", "the AI provider is rate limiting this server");
  if (err instanceof Anthropic.InternalServerError) return new LlmError("overloaded", "the AI provider is unavailable");
  if (err instanceof Anthropic.BadRequestError) return new LlmError("bad_request", "the AI provider rejected the request");
  return new LlmError("other", "the AI provider could not be reached");
}
