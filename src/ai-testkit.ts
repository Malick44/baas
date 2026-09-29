import type { LlmClient, LlmRequest, LlmResponse } from "./ai/llm.js";
import { LlmError } from "./ai/llm.js";

// A scripted stand-in for the model, for tests.
export type Block = Record<string, any>;
export type Turn = Block[] | ((req: LlmRequest) => Block[] | Promise<Block[]>);
let seq = 0;
export const text = (t: string): Block => ({ type: "text", text: t });
export const thinking = (): Block => ({ type: "thinking", thinking: "", signature: "sig-abc" });
export const use = (name: string, input: unknown): Block => ({ type: "tool_use", id: `toolu_${++seq}`, name, input });
export const query = (sql: string, purpose = "test") => use("run_query", { sql, purpose });
export const propose = (sql: string, explanation = "test change") => use("propose_change", { sql, explanation });

export class Scripted implements LlmClient {
  model = "scripted-model";
  requests: LlmRequest[] = [];
  private turns: Turn[] = [];
  stop: string | null = null;
  fail: Error | null = null;
  delayMs = 0;
  script(...turns: Turn[]) {
    this.turns = turns;
    this.requests = [];
    this.stop = null;
    this.fail = null;
    this.delayMs = 0;
  }
  async complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    if (this.fail) throw this.fail;
    if (this.delayMs) await new Promise<void>((res, rej) => { const t = setTimeout(res, this.delayMs); signal?.addEventListener("abort", () => { clearTimeout(t); rej(new LlmError("timeout", "aborted")); }); });
    const turn = this.turns[Math.min(this.requests.length - 1, this.turns.length - 1)] ?? [text("done")];
    const content = typeof turn === "function" ? await turn(req) : turn;
    const stopReason = this.stop ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    return { content, stopReason, model: this.model, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 } };
  }
}

