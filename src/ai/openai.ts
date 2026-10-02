import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "./llm.js";

/**
 * A model behind an OpenAI-style Chat Completions API: OpenAI itself, Azure OpenAI, OpenRouter, Ollama, vLLM, LM Studio, LiteLLM and
 * the many others that speak it. No SDK: one `fetch` to `<baseUrl>/chat/completions`.
 *
 * The assistant works in Anthropic-shaped content blocks (text, tool_use, tool_result); this translates both ways, so nothing else
 * in the assistant knows which provider answers.
 */
export type OpenAiLlmOptions = {
  model: string;
  /** Default https://api.openai.com/v1. Include the version path, e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl?: string;
  /** Sent as a bearer token. Optional, for local servers that need none. */
  apiKey?: string;
  /** For reasoning models ("o" series, gpt-5): low | medium | high. Left out when unset, since other servers reject the field. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Extra headers, such as Azure's `api-key`. */
  headers?: Record<string, string>;
  maxTokens?: number;
  timeoutMs?: number;
  /** Which field carries the output cap. OpenAI's newer models want max_completion_tokens; most compatible servers still use max_tokens. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  fetch?: typeof fetch;
};

type OaMessage = Record<string, unknown>;

/** The conversation in OpenAI's shape: tool results become `tool` messages, tool_use blocks become `tool_calls`. */
export function toOpenAiMessages(req: LlmRequest): OaMessage[] {
  const out: OaMessage[] = [];
  const system = req.system.join("\n\n");
  if (system) out.push({ role: "system", content: system });
  for (const m of req.messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn is the tool results (each its own message, in order) and any plain text after them.
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: typeof b.content === "string" ? (b.is_error ? `Error: ${b.content}` : b.content) : JSON.stringify(b.content) });
    }
    const text = m.content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const FINISH: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

export class OpenAiLlm implements LlmClient {
  readonly model: string;
  /** The host the questions go to, for the notice shown to users. */
  readonly provider: string;
  private f: typeof fetch;

  constructor(private opts: OpenAiLlmOptions) {
    this.model = opts.model;
    this.f = opts.fetch ?? fetch;
    const u = opts.baseUrl ?? "https://api.openai.com/v1";
    try { const url = new URL(u); if (!/^https?:$/.test(url.protocol)) throw new Error(); this.provider = url.host; } catch { throw new Error("the AI base URL must start with http:// or https://"); }
  }

  async complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const url = `${(this.opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
    const body = {
      model: this.opts.model,
      messages: toOpenAiMessages(req),
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: "auto",
      [this.opts.maxTokensField ?? "max_tokens"]: this.opts.maxTokens ?? 8000,
      ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
    };
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 90_000);
    let res: Response;
    try {
      res = await this.f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}), ...(this.opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      const name = (e as Error)?.name;
      throw new LlmError(name === "AbortError" || name === "TimeoutError" ? "timeout" : "other", name === "AbortError" || name === "TimeoutError" ? "the AI provider timed out" : "the AI provider could not be reached");
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {}); // never echoed: provider messages can carry request detail
      throw new LlmError(res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : res.status >= 500 ? "overloaded" : res.status === 408 ? "timeout" : "bad_request",
        res.status === 401 || res.status === 403 ? "the AI provider rejected the server's credentials" : res.status === 429 ? "the AI provider is rate limiting this server" : res.status >= 500 ? "the AI provider is unavailable" : "the AI provider rejected the request");
    }
    let j: any;
    try { j = await res.json(); } catch { throw new LlmError("other", "the AI provider answered with something unreadable"); }
    const choice = j?.choices?.[0];
    if (!choice?.message) throw new LlmError("other", "the AI provider answered with something unreadable");
    const content: Array<Record<string, any>> = [];
    if (typeof choice.message.content === "string" && choice.message.content) content.push({ type: "text", text: choice.message.content });
    else if (Array.isArray(choice.message.content)) for (const p of choice.message.content) if (p?.type === "text" && typeof p.text === "string") content.push({ type: "text", text: p.text });
    if (choice.message.refusal) content.push({ type: "text", text: String(choice.message.refusal) });
    for (const c of choice.message.tool_calls ?? []) {
      let input: unknown = {};
      try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = { __invalid_arguments: String(c.function?.arguments).slice(0, 200) }; }
      content.push({ type: "tool_use", id: String(c.id), name: String(c.function?.name ?? ""), input });
    }
    const u = j.usage ?? {};
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? 0);
    return {
      content,
      stopReason: choice.message.refusal ? "refusal" : content.some((b) => b.type === "tool_use") ? "tool_use" : FINISH[choice.finish_reason] ?? "end_turn",
      usage: { inputTokens: Math.max(0, Number(u.prompt_tokens ?? 0) - cached), outputTokens: Number(u.completion_tokens ?? 0), cacheReadTokens: cached, cacheWriteTokens: 0 },
      model: String(j.model ?? this.opts.model),
    };
  }
}
