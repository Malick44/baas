import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { LlmError, type LlmRequest } from "./ai/llm.js";
import { OpenAiLlm, toOpenAiMessages } from "./ai/openai.js";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

const TOOLS: LlmRequest["tools"] = [{ name: "run_query", description: "run sql", input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"], additionalProperties: false } }];

/** A stand-in for an OpenAI-style server: records each request and answers from a queue. */
function fakeServer() {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const replies: Array<{ status?: number; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const r = replies.shift() ?? { body: { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: {} } };
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });
  return {
    seen, replies,
    async listen() { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
const toolCall = (id: string, sql: string) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "run_query", arguments: JSON.stringify({ sql, purpose: "test" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 10 }, model: "gpt-test" });

describe("an OpenAI-style provider", () => {
  const srv = fakeServer();
  let base: string;
  before(async () => { base = await srv.listen(); });
  after(() => srv.close());

  it("turns the assistant's conversation into chat messages and back", () => {
    const msgs = toOpenAiMessages({
      system: ["be careful", "use SQL"], tools: TOOLS,
      messages: [
        { role: "user", content: "how many orders?" },
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "let me look" }, { type: "tool_use", id: "c1", name: "run_query", input: { sql: "select 1" } }, { type: "tool_use", id: "c2", name: "run_query", input: { sql: "select 2" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "{\"rows\":1}" }, { type: "tool_result", tool_use_id: "c2", is_error: true, content: "boom" }] },
      ],
    });
    assert.deepEqual(msgs, [
      { role: "system", content: "be careful\n\nuse SQL" },
      { role: "user", content: "how many orders?" },
      { role: "assistant", content: "let me look", tool_calls: [
        { id: "c1", type: "function", function: { name: "run_query", arguments: "{\"sql\":\"select 1\"}" } },
        { id: "c2", type: "function", function: { name: "run_query", arguments: "{\"sql\":\"select 2\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "{\"rows\":1}" },
      { role: "tool", tool_call_id: "c2", content: "Error: boom" },
    ]);
  });

  it("sends the request an OpenAI-style server expects and reads text, tool calls and usage", async () => {
    const llm = new OpenAiLlm({ model: "gpt-test", baseUrl: `${base}/`, apiKey: "sk-test", reasoningEffort: "high" });
    assert.equal(llm.provider, new URL(base).host);
    srv.replies.push({ body: toolCall("call_1", "select 1") });
    const res = await llm.complete({ system: ["sys"], tools: TOOLS, messages: [{ role: "user", content: "q" }] });
    const sent = srv.seen.at(-1)!;
    assert.equal(sent.url, "/v1/chat/completions");
    assert.equal(sent.headers.authorization, "Bearer sk-test");
    assert.equal(sent.body.model, "gpt-test");
    assert.equal(sent.body.reasoning_effort, "high");
    assert.equal(sent.body.tool_choice, "auto");
    assert.deepEqual(sent.body.tools[0], { type: "function", function: { name: "run_query", description: "run sql", parameters: TOOLS[0]!.input_schema } });
    assert.equal(sent.body.max_tokens, 8000);
    assert.deepEqual(res.content, [{ type: "tool_use", id: "call_1", name: "run_query", input: { sql: "select 1", purpose: "test" } }]);
    assert.equal(res.stopReason, "tool_use");
    assert.deepEqual(res.usage, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    assert.equal(res.model, "gpt-test");

    srv.replies.push({ body: { choices: [{ message: { content: "42 orders" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } } });
    const done = await new OpenAiLlm({ model: "m", baseUrl: base, maxTokensField: "max_completion_tokens" }).complete({ system: [], tools: [], messages: [{ role: "user", content: "q" }] });
    assert.deepEqual(done.content, [{ type: "text", text: "42 orders" }]);
    assert.equal(done.stopReason, "end_turn");
    assert.deepEqual(done.usage, { inputTokens: 40, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 0 }, "cached prompt tokens are counted separately");
    const second = srv.seen.at(-1)!;
    assert.equal(second.headers.authorization, undefined, "no key: nothing sent, for local servers");
    assert.equal(second.body.max_completion_tokens, 8000);
    assert.equal("max_tokens" in second.body, false);
    assert.equal("reasoning_effort" in second.body, false);

    for (const [finish, want] of [["length", "max_tokens"], ["content_filter", "refusal"]] as const) {
      srv.replies.push({ body: { choices: [{ message: { content: "x" }, finish_reason: finish }] } });
      assert.equal((await new OpenAiLlm({ model: "m", baseUrl: base }).complete({ system: [], tools: [], messages: [{ role: "user", content: "q" }] })).stopReason, want);
    }
    srv.replies.push({ body: { choices: [{ message: { content: null, refusal: "I can't help with that" }, finish_reason: "stop" }] } });
    const refused = await new OpenAiLlm({ model: "m", baseUrl: base }).complete({ system: [], tools: [], messages: [{ role: "user", content: "q" }] });
    assert.equal(refused.stopReason, "refusal");
    srv.replies.push({ body: { choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "run_query", arguments: "{not json" } }] }, finish_reason: "tool_calls" }] } });
    const bad = await new OpenAiLlm({ model: "m", baseUrl: base }).complete({ system: [], tools: TOOLS, messages: [{ role: "user", content: "q" }] });
    assert.equal(bad.content[0]!.input.sql, undefined, "unreadable arguments reach the tool as invalid input, not as a crash");
  });

  it("turns failures into the small vocabulary and never repeats what the provider said", async () => {
    const ask = () => new OpenAiLlm({ model: "m", baseUrl: base, apiKey: "k" }).complete({ system: [], tools: [], messages: [{ role: "user", content: "q" }] });
    for (const [status, kind] of [[401, "auth"], [403, "auth"], [429, "rate_limit"], [500, "overloaded"], [503, "overloaded"], [400, "bad_request"], [404, "bad_request"], [408, "timeout"]] as const) {
      srv.replies.push({ status, body: { error: { message: "secret detail: sk-live-123 and table names" } } });
      const err = await ask().catch((e) => e);
      assert.ok(err instanceof LlmError, String(status));
      assert.equal(err.kind, kind, String(status));
      assert.doesNotMatch(err.message, /secret|sk-live/);
    }
    srv.replies.push({ body: "not json at all" });
    assert.equal(((await ask().catch((e) => e)) as LlmError).kind, "other");
    srv.replies.push({ body: { choices: [] } });
    assert.equal(((await ask().catch((e) => e)) as LlmError).kind, "other");
    const down = await new OpenAiLlm({ model: "m", baseUrl: "http://127.0.0.1:1/v1" }).complete({ system: [], tools: [], messages: [{ role: "user", content: "q" }] }).catch((e) => e);
    assert.equal(down.kind, "other");
    const slow = await new OpenAiLlm({ model: "m", baseUrl: base, timeoutMs: 30, fetch: (async (_u: string, i: RequestInit) => { await new Promise((_r, rej) => i.signal!.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "TimeoutError" })))); }) as unknown as typeof fetch })
      .complete({ system: [], tools: [], messages: [{ role: "user", content: "q" }] }).catch((e) => e);
    assert.equal(slow.kind, "timeout");
    assert.throws(() => new OpenAiLlm({ model: "m", baseUrl: "ftp://x" }), /http/);
  });
});

describe("Ask AI over an OpenAI-style provider", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  const srv = fakeServer();
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<typeof t.project>>;
  before(async () => {
    const base = await srv.listen();
    t = await makePlatform(ADMIN!, { ai: { openai: { model: "gpt-test", baseUrl: base, apiKey: "sk-test" } } });
    owner = await t.org();
    p = await t.project(owner, "oa-shop");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
    await t.sql(owner, p.ref, "create table public.items (id serial primary key, name text); insert into public.items (name) values ('a'), ('b'), ('c')");
    await t.api("PUT", `/v1/projects/${p.ref}/ai/config`, { token: owner, body: { allowBypassRls: true } });
  });
  after(async () => { await t?.close(); await srv.close(); });

  it("names the provider in the notice, and answers a question by running a query the model chose", async () => {
    const st = (await t.api("GET", `/v1/projects/${p.ref}/ai`, { token: owner })).json;
    assert.deepEqual([st.available, st.model], [true, "gpt-test"]);
    assert.match(st.notice, /sent to 127\.0\.0\.1:\d+ to generate/, "says where the data goes, not 'Anthropic'");
    assert.equal((await t.api("POST", `/v1/projects/${p.ref}/ai/enable`, { token: owner })).status, 200);
    srv.replies.push({ body: toolCall("call_9", "select count(*)::int as n from public.items") });
    srv.replies.push({ body: { choices: [{ message: { content: "There are 3 items." }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 8 } } });
    const r = await t.api("POST", `/v1/projects/${p.ref}/ai/ask`, { token: owner, body: { question: "how many items?" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.answer, "There are 3 items.");
    assert.equal(r.json.steps[0].tool, "run_query");
    assert.deepEqual(r.json.steps[0].rows?.[0] ?? r.json.steps[0].result?.rows?.[0], [3]);
    const second = srv.seen.at(-1)!.body.messages;
    assert.equal(second.at(-2).tool_calls[0].id, "call_9", "the model's own call is sent back");
    assert.equal(second.at(-1).role, "tool");
    assert.equal(second.at(-1).tool_call_id, "call_9", "with its result under the same id");
    assert.match(second.at(-1).content, /3/);
    assert.match(second[0].content, /SELECT|read-only|database/i, "the instructions go in as the system message");
  });

  it("says plainly when the provider rejects the server's key", async () => {
    srv.replies.push({ status: 401, body: { error: { message: "bad key sk-test" } } });
    const r = await t.api("POST", `/v1/projects/${p.ref}/ai/ask`, { token: owner, body: { question: "again?" } });
    assert.notEqual(r.status, 200);
    assert.doesNotMatch(r.text, /sk-test/);
  });
});
