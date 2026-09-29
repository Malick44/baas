// Browser end-to-end test: drives the dashboard in headless Chromium against a real platform instance.
// Run with: BAAS_TEST_PG_URL=postgres://... npm run e2e
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { Agent, fetch as ufetch } from "undici";
import { text, use } from "../src/ai-testkit.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/ai/llm.js";
import { makePlatform } from "../src/platform-testkit.js";

/** A tiny rule-based stand-in for the model, so the dashboard's AI tab can be driven end to end. */
class RuleLlm implements LlmClient {
  model = "e2e-model";
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const last = req.messages.at(-1)!.content;
    let content: Array<Record<string, any>>;
    if (typeof last === "string") {
      const q = last.toLowerCase();
      if (q.includes("how many notes")) content = [use("run_query", { sql: "select count(*) as n from public.notes", purpose: "Count the notes" })];
      else if (q.includes("add a note")) content = [use("propose_change", { sql: "INSERT INTO public.notes (body) VALUES ('added by AI')", explanation: "Adds one note." })];
      else if (q.includes("delete every note")) content = [use("propose_change", { sql: "DELETE FROM public.notes", explanation: "Just tidying up, completely safe." })];
      else if (q.includes("remove the ai note")) content = [use("propose_change", { sql: "DELETE FROM public.notes WHERE body = 'added by AI'", explanation: "Removes the note the assistant added." })];
      else content = [text("I don't know how to answer that.")];
    } else {
      const r = JSON.parse((last as any[])[0].content);
      content = [text(r.status ? "I prepared a change for you to review." : `The notes table has ${r.rows[0][0]} row(s).`)];
    }
    return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", model: this.model, usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}

const ADMIN = process.env.BAAS_TEST_PG_URL;
const CHROME = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOTS = join(import.meta.dirname, "screenshots");

// Node cannot resolve <ref>.localhost by itself (browsers can), so map it to loopback for direct API checks.
const lookup = (_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
const agent = new Agent({ connect: { lookup } });
const dnsFetch = (url: string, init: any = {}) => ufetch(url, { ...init, dispatcher: agent });

const freePort = () => new Promise<number>((res) => {
  const s = createServer().listen(0, () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => res(p));
  });
});

describe("dashboard in a real browser", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let apiPort: number;
  let gwPort: number;
  let owner: string;
  let ref: string;
  let anon: string;
  const problems: string[] = [];

  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  const toast = (text: string | RegExp) => page.locator(".toast", { hasText: text }).first().waitFor({ timeout: 8000 });
  /** Open a section the way a person would: rail icon, then the section sidebar for database pages. */
  const tab = async (id: string, sub?: string) => {
    const section = id === "backups" ? "database" : id;
    const subPage = id === "backups" ? "backups" : sub;
    await page.click(`nav.rail a[data-tab=${section}]`);
    if (section === "database" && subPage) await page.click(`nav.sub a[data-dbpage=${subPage}]`);
    const want = section === "database" ? `database/${subPage ?? "tables"}` : section;
    await page.waitForFunction((w) => { const b = document.querySelector("#tab-body"); return b?.getAttribute("data-page") === w && !b.textContent?.startsWith("Loading"); }, want);
  };
  const rest = async (path: string, init: any = {}, key = anon) =>
    dnsFetch(`http://${ref}.localhost:${gwPort}${path}`, { ...init, headers: { apikey: key, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as object) } });

  /** Like it(), but keeps a screenshot and any open dialog's text when a step fails. */
  const step = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      try {
        await fn();
      } catch (e) {
        const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50);
        await page.screenshot({ path: join(SHOTS, `FAIL-${slug}.png`), fullPage: true }).catch(() => {});
        const dlg = await page.locator("dialog[open]").allTextContents().catch(() => []);
        console.error(`STEP FAILED: ${name}\n  open dialogs: ${JSON.stringify(dlg)}\n  url: ${page.url()}`);
        throw e;
      }
    });

  before(async () => {
    await mkdir(SHOTS, { recursive: true });
    [apiPort, gwPort] = [await freePort(), await freePort()];
    t = await makePlatform(ADMIN!, { publicPort: gwPort, ai: { llm: new RuleLlm() } });
    await t.platform.listen({ api: apiPort, gateway: gwPort, host: "127.0.0.1" });
    owner = await t.org("e2e-org");
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    page = await ctx.newPage();
    page.on("console", (m) => {
      const text = m.text();
      // Failed requests the tests provoke on purpose are 4xx; anything else at error level is a problem.
      if (m.type() === "error" && !/status of 4\d\d|Failed to load resource: the server responded with a status of (401|403|404|409|422)/.test(text)) problems.push(`console: ${text}`);
      if (/Content Security Policy|Refused to/i.test(text)) problems.push(`CSP: ${text}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  });

  after(async () => {
    await browser?.close();
    await t?.close();
    assert.deepEqual(problems, [], "the dashboard must not log errors or violate its CSP");
  });

  step("shows the sign-in page and rejects a bad token", async () => {
    await page.goto(`http://127.0.0.1:${apiPort}/`);
    await page.waitForSelector("#token");
    await shot("01-login");
    await page.fill("#token", "baas_not_a_real_token");
    await page.click("#signin");
    await page.locator("#login-error").waitFor();
    assert.match((await page.textContent("#login-error"))!, /not accepted/);
  });

  step("signs in and shows an empty project list", async () => {
    await page.fill("#token", owner);
    await page.click("#signin");
    await page.waitForSelector("#project-grid");
    await page.waitForSelector(".empty");
    await page.click("#avatar");
    assert.match((await page.textContent("#who"))!, /e2e-org\s*owner/);
    await page.keyboard.press("Escape");
    await page.click("h1, .empty"); // click away closes the menu
    assert.equal(await page.locator(".menu").count(), 0);
    await shot("02-projects-empty");
  });

  step("creates a project and lands on its overview", async () => {
    await page.click("#new-project");
    await page.fill("#project-name", "shop");
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("#stat-grid");
    assert.equal((await page.textContent("#project-status"))!.trim(), "active");
    assert.equal((await page.textContent("#project-title"))!.trim(), "shop");
    ref = /#\/p\/([a-z0-9]{20})\//.exec(page.url())![1]!;
    t.refs.push(ref);
    assert.equal(await page.textContent("#project-url"), `http://${ref}.localhost:${gwPort}`);
    assert.match((await page.textContent("#stat-grid"))!, /Healthy/);
    const keys = (await t.api("GET", `/v1/projects/${ref}/api-keys`, { token: owner })).json;
    anon = keys.anon;
    // The Connect dialog shows the URL and reveals keys on demand.
    await page.click("#connect-btn");
    assert.equal(await page.locator("dialog .kv code").first().textContent(), `http://${ref}.localhost:${gwPort}`);
    await page.locator("dialog button:has-text('Reveal')").first().click();
    assert.match((await page.locator("dialog .kv code").nth(1).textContent()) ?? "", /^eyJ/);
    await shot("03b-connect");
    await page.click("dialog button:has-text('Close')");
    await shot("03-overview");
    assert.match((await page.textContent("[data-stat=database]"))!, /of 500 MB/);
    assert.match((await page.textContent("[data-stat='requests today']"))!, /of 50,000/);
    assert.equal(await page.locator(".metric").count(), 5);
  });

  step("creates a table from the UI, with RLS on and API access granted", async () => {
    await tab("tables");
    await page.click("#new-table");
    await page.fill("#tname", "notes");
    await page.locator(".col-row").nth(1).locator("[name=cname]").fill("body");
    await page.click("#col-rows + button");
    await page.locator(".col-row").nth(2).locator("[name=cname]").fill("pinned");
    await page.locator(".col-row").nth(2).locator("[name=ctype]").selectOption("bool");
    await page.locator(".col-row").nth(2).locator("[name=cdef]").selectOption("false");
    await shot("04-new-table");
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("#table-name:has-text('notes')");
    await page.waitForSelector("#table-list [data-table=notes]");
    assert.match((await page.textContent("#table-main"))!, /3 columns · 0 policies · RLS on/);
    // Grants and RLS really exist: anon sees nothing (RLS, no policy) instead of an error.
    const r = await rest("/rest/v1/notes");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), []);
  });

  step("inserts, edits and deletes rows in the table editor", async () => {
    await page.click("#insert-row");
    await page.fill("dialog input[name=body]", "first note");
    await page.click("dialog button[type=submit]");
    await toast("Row inserted");
    await page.waitForSelector("#rows td:has-text('first note')");
    assert.match((await page.textContent("#row-count"))!, /1 row/);
    await page.dblclick("#rows td:has-text('first note')");
    await page.fill("#rows td.editing input", "edited note");
    await page.press("#rows td.editing input", "Enter");
    await toast("Saved");
    await page.waitForSelector("#rows td:has-text('edited note')");
    const svc = (await t.api("GET", `/v1/projects/${ref}/api-keys`, { token: owner })).json.service_role;
    assert.equal((await (await rest("/rest/v1/notes", {}, svc)).json())[0].body, "edited note");
    await shot("05-table-editor");

    await page.click("#insert-row");
    await page.fill("dialog input[name=body]", "second");
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("#rows td:has-text('second')");
    await page.locator("#rows tr", { hasText: "second" }).locator("[data-action=delete-row]").click();
    await page.click("dialog button[type=submit]");
    await toast("Row deleted");
    await page.waitForFunction(() => !document.querySelector("#rows")?.textContent?.includes("second"));
  });

  step("runs SQL, shows results and errors, and policies take effect through the API", async () => {
    await tab("sql");
    await page.fill("#sql-input", "select count(*) as n, 'x' as label from public.notes");
    await page.click("#run-sql");
    await page.waitForSelector("table.result");
    assert.match((await page.textContent("table.result"))!, /n\s*label\s*1\s*x/);

    await page.fill("#sql-input", "select * from nope");
    await page.click("#run-sql");
    await page.waitForSelector("#sql-error");
    assert.match((await page.textContent("#sql-error"))!, /nope/);

    await page.fill("#sql-input", "create policy \"anyone reads\" on public.notes for select to anon using (true);");
    await page.click("#run-sql");
    await page.waitForSelector("#sql-output .notice:has-text('CREATE')");
    const rows = await (await rest("/rest/v1/notes")).json();
    assert.deepEqual(rows.map((x: any) => x.body), ["edited note"]);
    await shot("06-sql-editor");

    // Snippet menu fills the editor.
    await page.selectOption("select[aria-label=Snippets]", "Owner-only policy");
    assert.match(await page.inputValue("#sql-input"), /auth\.uid\(\)/);
  });

  step("explores the database section: tables, policies, roles, extensions, indexes and more", async () => {
    await tab("database");
    await page.waitForSelector("#catalog-table tr[data-row=notes]");
    assert.match((await page.textContent("nav.sub"))!, /Database management[\s\S]*Tables[\s\S]*Functions[\s\S]*Triggers[\s\S]*Enumerated Types[\s\S]*Extensions[\s\S]*Indexes[\s\S]*Access control[\s\S]*Policies[\s\S]*Roles[\s\S]*Platform[\s\S]*Backups/);
    assert.match((await page.textContent("tr[data-row=notes]"))!, /table\s*3\s*on/);
    await shot("06d-db-tables");
    await page.locator("tr[data-row=notes] button:has-text('Columns')").click();
    const cols = (await page.textContent("dialog"))!;
    assert.ok(/id\s*bigint/.test(cols) && /body\s*text/.test(cols) && /pinned\s*boolean/.test(cols));
    await page.click("dialog button:has-text('Close')");
    await page.fill("#catalog-search", "zzz");
    assert.match((await page.textContent("#catalog-table"))!, /No matches/);
    await page.fill("#catalog-search", "");
    await page.selectOption("#catalog-schema", "auth");
    await page.waitForSelector("tr[data-row=users]");
    await page.selectOption("#catalog-schema", "public");

    await tab("database", "policies");
    await page.waitForSelector("tr[data-row='anyone reads']");
    assert.match((await page.textContent("tr[data-row='anyone reads']"))!, /notes\s*SELECT\s*anon/);
    await page.locator("tr[data-row='anyone reads'] button:has-text('Definition')").click();
    assert.match((await page.textContent("dialog pre"))!, /create policy "anyone reads" on "public"\."notes"[\s\S]*to anon[\s\S]*using \(true\)/);
    await page.click("dialog button:has-text('Close')");
    await shot("06d-db-policies");

    await tab("database", "roles");
    for (const r of ["anon", "authenticated", "service_role"]) await page.waitForSelector(`tr[data-row=${r}]`);
    assert.match((await page.textContent("tr[data-row=service_role]"))!, /yes/); // bypasses row-level security
    assert.equal(await page.locator("#catalog-table tr[data-row^=authenticator_]").count(), 1, "only this project's own login role is listed");

    await tab("database", "extensions");
    await page.waitForSelector("tr[data-row=pgcrypto]");
    assert.match((await page.textContent("tr[data-row=pgcrypto]"))!, /enabled/);
    await tab("database", "indexes");
    await page.waitForSelector("tr[data-row=notes_pkey]");
    assert.match((await page.textContent("tr[data-row=notes_pkey]"))!, /CREATE UNIQUE INDEX/);
    await tab("database", "triggers");
    await page.waitForSelector("#catalog-table .empty");
    assert.match((await page.textContent("#catalog-table"))!, /No triggers in this schema/);
    await t.sql(owner, ref, "create type public.mood as enum ('sad', 'ok', 'happy')");
    await tab("database", "enums");
    await page.waitForSelector("tr[data-row=mood]");
    assert.match((await page.textContent("tr[data-row=mood]"))!, /sad, ok, happy/);
    await t.sql(owner, ref, "drop type public.mood");
    await tab("database", "migrations");
    await page.waitForSelector("#catalog-table .empty");
    assert.match((await page.textContent("#catalog-table"))!, /No migrations applied yet/);
  });

  step("creates, edits, calls and deletes a database function", async () => {
    await tab("database", "functions");
    await page.waitForSelector("#catalog-table .empty");
    await page.click("#new-function");
    assert.match(await page.inputValue("#function-sql"), /hello_world/);
    await page.fill("#function-sql", "create or replace function public.add_numbers(a int, b int) returns int language sql as $$ select a + b; $$;\ngrant execute on function public.add_numbers(int, int) to anon;");
    await page.click("dialog button[type=submit]");
    await toast("Function created");
    await page.waitForSelector("tr[data-row=add_numbers]");
    const row = (await page.textContent("tr[data-row=add_numbers]"))!;
    assert.match(row, /a integer, b integer/);
    assert.match(row, /integer/);
    assert.match(row, /Invoker/);
    await shot("06e-db-functions");
    const call = async (a: number, b: number) => (await (await rest("/rest/v1/rpc/add_numbers", { method: "POST", body: JSON.stringify({ a, b }) })).json());
    assert.equal(await call(2, 3), 5, "callable through the API");

    // Editing applies create or replace, so grants survive.
    await page.locator("tr[data-row=add_numbers] [data-action=edit-function]").click();
    assert.match(await page.inputValue("#function-sql"), /select a \+ b/);
    await page.fill("#function-sql", (await page.inputValue("#function-sql")).replace("select a + b", "select a * b"));
    await page.click("dialog button[type=submit]");
    await toast("Function saved");
    assert.equal(await call(2, 3), 6);

    // A mistake is reported in the dialog, which stays open, and changes nothing.
    await page.locator("tr[data-row=add_numbers] [data-action=edit-function]").click();
    await page.fill("#function-sql", "create or replace function public.add_numbers(a int, b int) returns int language sql as $$ select nope; $$;");
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    assert.match((await page.textContent("dialog .notice.bad"))!, /nope/);
    await page.click("dialog button:has-text('Cancel')");
    assert.equal(await call(2, 3), 6);

    // Security definer is called out.
    await page.click("#new-function");
    await page.fill("#function-sql", "create or replace function public.secret_sum() returns int language sql security definer as $$ select 42; $$;");
    await page.click("dialog button[type=submit]");
    await toast("Function created");
    assert.match((await page.textContent("tr[data-row=secret_sum]"))!, /Definer/);

    // Deleting needs the name typed.
    await page.locator("tr[data-row=add_numbers] [data-action=drop-function]").click();
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    await page.fill("dialog input[name=typed]", "add_numbers");
    await page.click("dialog button[type=submit]");
    await toast("Function deleted");
    await page.waitForFunction(() => !document.querySelector("tr[data-row=add_numbers]"));
    assert.equal((await rest("/rest/v1/rpc/add_numbers", { method: "POST", body: JSON.stringify({ a: 1, b: 1 }) })).status, 404);
    await t.sql(owner, ref, "drop function public.secret_sum()");
  });

  step("jumps between pages with the command palette", async () => {
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#palette-input");
    await page.fill("#palette-input", "function");
    const labels = await page.locator("#palette-list button").allTextContents();
    assert.deepEqual(labels, ["Edge Functions", "Database › Functions"]);
    await page.press("#palette-input", "ArrowDown");
    await page.press("#palette-input", "Enter");
    await page.waitForFunction(() => document.querySelector("#tab-body")?.getAttribute("data-page") === "database/functions");
    await page.click("#open-palette");
    await page.fill("#palette-input", "no such page");
    assert.match((await page.textContent("#palette-list"))!, /No matching pages/);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog.palette"));
  });

  step("shows live request charts per service on the overview", async () => {
    await tab("overview");
    await page.waitForSelector("#metric-grid");
    const api = (await t.api("GET", `/v1/projects/${ref}/metrics`, { token: owner })).json;
    const shown = Number(/^([\d,]+)/.exec((await page.textContent("#total-requests"))!)![1]!.replace(/,/g, ""));
    assert.ok(shown > 0);
    assert.equal(shown, api.totals.requests, "the dashboard shows the same total as the API");
    assert.match((await page.textContent("#success-rate"))!, /^\d+(\.\d)?%\s*Success Rate/);
    assert.deepEqual(await page.locator(".metric .label").allTextContents(), ["REST API", "Auth", "Storage", "Edge Functions", "Realtime"]);
    assert.equal(await page.locator(".metric[data-service=rest] svg rect").count(), 24);
    assert.ok(Number((await page.textContent(".metric[data-service=rest] .total"))!.replace(/,/g, "")) > 0);
    await page.selectOption("#metric-range", "168");
    await page.waitForFunction(() => document.querySelectorAll(".metric[data-service=rest] svg rect").length === 56);
    await shot("03c-metrics");
    await page.selectOption("#metric-range", "24");
    await page.waitForFunction(() => document.querySelectorAll(".metric[data-service=rest] svg rect").length === 24);
  });

  step("asks the AI assistant in plain language; it answers, and can only propose changes", async () => {
    const notes = async () => (await (await rest("/rest/v1/notes?select=body&order=id", {}, svc)).json()).map((r: any) => r.body);
    const svc = (await t.api("GET", `/v1/projects/${ref}/api-keys`, { token: owner })).json.service_role;
    const ask = async (q: string) => {
      await page.fill("#ai-input", q);
      await page.click("#ai-send");
      await page.waitForFunction(() => !document.querySelector("[data-pending]") && !(document.querySelector("#ai-send") as HTMLButtonElement).disabled);
    };
    await tab("ai");
    await page.waitForSelector("#ai-off");
    assert.match((await page.textContent("#ai-notice"))!, /sent to Anthropic/);
    await shot("06b-ai-off");
    await page.click("#ai-enable");
    assert.match((await page.textContent("dialog"))!, /sent to Anthropic/);
    await page.click("dialog button[type=submit]");
    await toast("AI assistant enabled");
    await page.waitForSelector("#ai-input");

    // Row-level security applies by default: the first identity is an anonymous visitor, and "everyone" is not even offered.
    assert.equal(await page.inputValue("#ai-as"), "anon");
    assert.equal(await page.locator("#ai-as option[value=service]").count(), 0);
    await ask("How many notes are there?");
    assert.match((await page.textContent("[data-answered-as]"))!, /Answered as an anonymous visitor/);
    assert.match((await page.textContent("[data-answer]"))!, /The notes table has 1 row\(s\)\./);
    await page.click("details.step summary");
    assert.match((await page.textContent("details.step pre.sql"))!, /select count\(\*\) as n from public\.notes/);
    assert.match((await page.textContent("details.step table"))!, /n\s*1/);
    assert.match((await page.textContent("#ai-quota"))!, /\d+ of 20 questions used today/);
    await shot("06b-ai-answer");

    // Asking as a specific user shows what that user's policies allow, which can differ from the public view.
    await t.sql(owner, ref, `CREATE POLICY "auth hides edited" ON public.notes FOR SELECT TO authenticated USING (body <> 'edited note')`);
    await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: "ai-user@example.com", password: "secret123" }) });
    await page.selectOption("#ai-as", "user");
    await page.fill("#ai-user-q", "ai-user");
    await page.click("#ai-user-search");
    await page.click("#ai-user-results [data-user='ai-user@example.com']");
    assert.equal((await page.textContent("#ai-user-chip"))!.trim(), "ai-user@example.com");
    await ask("How many notes are there?");
    assert.match((await page.locator("[data-answered-as]").last().textContent())!, /Answered as user ai-user@example\.com/);
    assert.match((await page.locator("[data-answer]").last().textContent())!, /The notes table has 0 row\(s\)\./);
    await shot("06b-ai-as-user");
    await t.sql(owner, ref, `DROP POLICY "auth hides edited" ON public.notes`);

    // "Everyone" mode is the owner's decision, and an admin cannot make it.
    const adminPage = await ctx.newPage();
    adminPage.on("pageerror", (e) => problems.push(`admin pageerror: ${e.message}`));
    await adminPage.goto(`http://127.0.0.1:${apiPort}/`);
    await adminPage.fill("#token", await t.token(owner, "admin"));
    await adminPage.click("#signin");
    await adminPage.waitForSelector("#project-grid");
    await adminPage.goto(`http://127.0.0.1:${apiPort}/#/p/${ref}/ai`);
    await adminPage.waitForSelector("#ai-settings");
    await adminPage.click("#ai-settings summary");
    assert.equal(await adminPage.isDisabled("#ai-allow-bypass"), true);
    assert.match((await adminPage.textContent("#ai-settings"))!, /Only a project owner can turn this on/);
    await adminPage.close();
    await page.click("#ai-settings summary");
    await page.check("#ai-allow-bypass");
    assert.match((await page.textContent("dialog"))!, /every row in your public tables/);
    await page.click("dialog button[type=submit]");
    await toast("Everyone mode allowed");
    await page.waitForSelector("#ai-as option[value=service]", { state: "attached" });
    await page.selectOption("#ai-as", "service");
    await ask("How many notes are there?");
    assert.match((await page.locator("[data-answered-as]").last().textContent())!, /Answered as everyone — row-level security ignored/);
    assert.match((await page.locator("[data-answer]").last().textContent())!, /The notes table has 1 row\(s\)\./);

    // A change is only proposed. Nothing happens until a person runs it.
    await ask("Please add a note");
    await page.waitForSelector("[data-proposal]");
    assert.match((await page.textContent("[data-proposal]"))!, /not run yet/);
    assert.equal(await page.locator("[data-proposal] [data-risk]").first().textContent(), "adds rows");
    assert.deepEqual(await notes(), ["edited note"], "a proposal changes nothing");
    await page.click("[data-proposal] [data-action=run-proposal]");
    assert.match((await page.textContent("dialog"))!, /written by an AI model/);
    await page.click("dialog button[type=submit]");
    await toast("Change applied");
    assert.deepEqual(await notes(), ["edited note", "added by AI"]);

    // A destructive proposal is labelled from its SQL, not from the assistant's reassurance, and needs a typed confirmation.
    await ask("Delete every note");
    const card = page.locator("[data-proposal]").last();
    assert.match((await card.textContent())!, /Just tidying up, completely safe\./);
    assert.match((await card.locator("[data-risk]").first().textContent())!, /deletes EVERY row \(no WHERE\)/);
    assert.ok((await card.locator("[data-risk]").first().getAttribute("class"))!.includes("failed"), "destructive proposals are shown in red");
    await shot("06c-ai-destructive");
    await card.locator("[data-action=run-proposal]").click();
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    await page.fill("#confirm-run", "sure");
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    await page.click("dialog button:has-text('Cancel')");
    assert.deepEqual(await notes(), ["edited note", "added by AI"], "an unconfirmed destructive change does nothing");
    await card.locator("button:has-text('Dismiss')").click();
    assert.match((await card.textContent())!, /Dismissed\. Nothing was run\./);

    // A scoped change goes through the same confirmation path and cleans up after itself.
    await ask("Remove the AI note");
    const scoped = page.locator("[data-proposal]").last();
    assert.match((await scoped.locator("[data-risk]").first().textContent())!, /^deletes rows$/);
    await scoped.locator("[data-action=run-proposal]").click();
    await page.click("dialog button[type=submit]");
    await scoped.locator("text=/^Ran\./").waitFor();
    assert.deepEqual(await notes(), ["edited note"]);

    await ask("Tell me a joke");
    assert.match((await page.locator("[data-answer]").last().textContent())!, /don't know/);
    assert.equal(await page.locator("#ai-chat [data-ai-error]").count(), 0);

    // Owners can take "everyone" mode away again; the option disappears.
    await page.click("#ai-settings summary");
    await page.uncheck("#ai-allow-bypass");
    await toast("Everyone mode turned off");
    await page.waitForSelector("#ai-as");
    assert.equal(await page.locator("#ai-as option[value=service]").count(), 0);
    assert.equal(await page.inputValue("#ai-as"), "anon");

    // Turning it off removes the assistant's access again.
    await page.click("#ai-disable");
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("#ai-off");
    const audit = (await t.api("GET", "/v1/audit-log", { token: owner })).json.map((e: any) => e.action);
    assert.ok(audit.includes("ai.enable") && audit.includes("ai.disable") && audit.includes("ai.ask"));
  });

  step("manages users", async () => {
    await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: "signed-up@example.com", password: "secret123" }) });
    await tab("auth");
    await page.waitForSelector("#users tr[data-email='signed-up@example.com']");
    await page.click("#new-user");
    await page.fill("#user-email", "made-in-dashboard@example.com");
    await page.fill("#user-password", "secret123");
    await page.click("dialog button[type=submit]");
    await toast("User created");
    await page.waitForSelector("#users tr[data-email='made-in-dashboard@example.com']");
    assert.match((await page.textContent("#user-count"))!, /\(3\)/); // includes the user the AI step created
    await shot("07-users");

    const row = page.locator("#users tr[data-email='signed-up@example.com']");
    await row.locator("button:has-text('Ban')").click();
    await toast("User banned");
    await page.waitForSelector("#users tr[data-email='signed-up@example.com'] .bad");
    const login = await rest("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: "signed-up@example.com", password: "secret123" }) });
    assert.equal(login.status, 400);
    await page.locator("#users tr[data-email='signed-up@example.com'] [data-action=delete-user]").click();
    await page.click("dialog button[type=submit]");
    await toast("User deleted");
    await page.waitForFunction(() => !document.querySelector("#users")?.textContent?.includes("signed-up@example.com"));
  });

  step("creates a bucket, uploads, downloads, shares and deletes a file", async () => {
    await tab("storage");
    await page.click("#new-bucket");
    await page.fill("#bucket-name", "photos");
    await page.check("#bucket-public");
    await page.click("dialog button[type=submit]");
    await toast("Bucket created");
    await page.waitForSelector("#bucket-list [data-bucket=photos]");
    await page.setInputFiles("#upload-input", { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello from the browser") });
    await toast("Uploaded hello.txt");
    await page.waitForSelector("#objects tr[data-name='hello.txt']");
    assert.match((await page.textContent("#objects tr[data-name='hello.txt']"))!, /22 B|22 B/);
    await shot("08-storage");
    // Public bucket: readable without credentials.
    const pub = await dnsFetch(`http://${ref}.localhost:${gwPort}/storage/v1/object/public/photos/hello.txt`);
    assert.equal(await pub.text(), "hello from the browser");
    // Download through the dashboard.
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("[data-action=download]")]);
    assert.equal(download.suggestedFilename(), "hello.txt");
    // Signed URL dialog.
    await page.locator("#objects tr[data-name='hello.txt'] button:has-text('Share')").click();
    const signed = await page.inputValue("dialog textarea");
    assert.match(signed, new RegExp(`^http://${ref}\\.localhost:${gwPort}/storage/v1/object/sign/photos/hello\\.txt\\?token=`));
    assert.equal(await (await dnsFetch(signed)).text(), "hello from the browser");
    await page.click("dialog button[type=submit]");
    await page.locator("[data-action=delete-object]").click();
    await page.click("dialog button[type=submit]");
    await toast("File deleted");
    await page.waitForSelector("#objects", { state: "detached" }).catch(() => {});
  });

  step("deploys and invokes a function and shows its logs", async () => {
    await tab("functions");
    await page.fill("#fn-name", "hello");
    await page.click("#fn-deploy");
    await toast("Deployed hello v1");
    await page.waitForSelector("#fn-list [data-fn=hello]");
    await page.fill("#fn-name", "hello");
    await page.click("#fn-invoke");
    await page.waitForFunction(() => /^200/.test(document.querySelector("#fn-result")?.textContent ?? ""), null, { timeout: 8000 });
    const out = (await page.textContent("#fn-result"))!;
    assert.match(out, /Hello dashboard!/);
    assert.match(out, new RegExp(`${ref}\\.localhost:${gwPort}`));
    await page.click("#fn-list [data-fn=hello]");
    await page.waitForSelector("#fn-logs tbody tr");
    await shot("09-functions");
    // A syntax error is rejected with a clear message and nothing is deployed.
    await page.fill("#fn-source", "export default (");
    await page.click("#fn-deploy");
    await toast(/syntax error/);
  });

  step("streams realtime changes into the inspector", async () => {
    await tab("realtime");
    await page.selectOption("#rt-table", "notes");
    await page.click("#rt-start");
    await page.waitForFunction(() => /listening to notes/.test(document.querySelector("#rt-status")?.textContent ?? ""), null, { timeout: 8000 });
    const svc = (await t.api("GET", `/v1/projects/${ref}/api-keys`, { token: owner })).json.service_role;
    await rest("/rest/v1/notes", { method: "POST", body: JSON.stringify({ body: "live from api" }) }, svc);
    await page.waitForSelector("#rt-events .event:has-text('live from api')", { timeout: 8000 });
    assert.match((await page.textContent("#rt-events .event"))!, /INSERT notes/);
    await shot("10-realtime");
  });

  step("lists request logs and activity", async () => {
    await tab("logs");
    await page.waitForSelector("#request-log tbody tr");
    assert.match((await page.textContent("#request-log"))!, /\/rest\/v1\/notes/);
    assert.match((await page.textContent("#audit-log"))!, /project\.sql/);
    assert.match((await page.textContent("#audit-log"))!, /project\.sql/);
    await shot("11-logs");
  });

  step("backs up and restores the database", async () => {
    await tab("backups");
    await page.click("#create-backup");
    await toast("Backup created");
    await page.waitForSelector("#backup-list tbody tr");
    await tab("sql");
    await page.fill("#sql-input", "delete from public.notes");
    await page.click("#run-sql");
    await page.waitForSelector("#sql-output .notice:has-text('DELETE')");
    const svc = (await t.api("GET", `/v1/projects/${ref}/api-keys`, { token: owner })).json.service_role;
    assert.deepEqual(await (await rest("/rest/v1/notes", {}, svc)).json(), []);
    await tab("backups");
    await page.click("[data-action=restore]");
    await page.fill("dialog input[name=typed]", "shop");
    await page.click("dialog button[type=submit]");
    await toast("Restored");
    const back = await (await rest("/rest/v1/notes?order=id", {}, svc)).json();
    assert.ok(back.some((x: any) => x.body === "edited note"), "restored data is visible again");
    await shot("12-backups");
  });

  step("saves settings that the API enforces, and changes the plan", async () => {
    await tab("settings");
    await page.fill("#set-expiry", "900");
    await page.check("#set-disable");
    await page.fill("#set-env", "GREETING=hola");
    await page.click("#save-settings");
    await toast("Settings saved");
    t.platform.dir.forget(ref);
    const su = await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: "late@example.com", password: "secret123" }) });
    assert.equal(su.status, 422);
    await page.uncheck("#set-disable");
    await page.click("#save-settings");
    await toast("Settings saved");
    t.platform.dir.forget(ref);
    const ok = await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: "late@example.com", password: "secret123" }) });
    assert.equal((await ok.json()).expires_in, 900);
    await page.selectOption("#set-plan", "pro");
    await page.click("#save-plan");
    await toast("Plan updated");
    await shot("13-settings");
    await tab("overview");
    assert.equal((await page.locator("header.appbar .chip").first().textContent())!.trim(), "pro");
    assert.match((await page.textContent("[data-stat='requests today']"))!, /of 5,000,000/);
  });

  step("pauses the project (API offline) and resumes it", async () => {
    await tab("settings");
    await page.click("#pause-project");
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("#resume-project");
    assert.equal((await page.textContent("#project-status"))!.trim(), "paused");
    assert.match((await page.textContent("#paused-note"))!, /paused/);
    t.platform.dir.forget(ref);
    assert.equal((await rest("/rest/v1/notes")).status, 503);
    await shot("14-paused");
    await page.click("#resume-project");
    await page.waitForSelector("#pause-project");
    t.platform.dir.forget(ref);
    assert.equal((await rest("/rest/v1/notes")).status, 200);
  });

  step("limits what a developer sees and can do", async () => {
    const dev = await t.token(owner, "developer");
    const p2 = await ctx.newPage();
    p2.on("pageerror", (e) => problems.push(`dev pageerror: ${e.message}`));
    await p2.goto(`http://127.0.0.1:${apiPort}/`);
    await p2.fill("#token", dev);
    await p2.click("#signin");
    await p2.waitForSelector("#project-grid");
    assert.equal(await p2.isDisabled("#new-project"), true);
    await p2.click("#avatar");
    assert.match((await p2.textContent("#who"))!, /developer/);
    await p2.keyboard.press("Escape");
    await p2.click(".project-card");
    await p2.waitForSelector("#stat-grid");
    await p2.click("#connect-btn");
    assert.match((await p2.textContent("dialog"))!, /Requires the admin role/);
    await p2.keyboard.press("Escape");
    await p2.click("nav.rail a[data-tab=ai]");
    await p2.waitForSelector("#ai-off");
    assert.equal(await p2.isDisabled("#ai-enable"), true);
    await p2.click("nav.rail a[data-tab=sql]");
    await p2.fill("#sql-input", "select 1");
    await p2.click("#run-sql");
    await p2.waitForSelector("#sql-error");
    assert.match((await p2.textContent("#sql-error"))!, /requires admin/);
    await p2.close();
  });

  step("is usable on a phone-sized screen", async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
    const p = await m.newPage();
    await p.goto(`http://127.0.0.1:${apiPort}/`);
    await p.fill("#token", owner);
    await p.click("#signin");
    await p.waitForSelector(".project-card");
    const overflow = () => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok((await overflow()) <= 1, `project list scrolls horizontally by ${await overflow()}px`);
    await p.screenshot({ path: join(SHOTS, "15-mobile.png"), fullPage: true });
    for (const tabName of ["overview", "tables", "sql", "settings"]) {
      await p.goto(`http://127.0.0.1:${apiPort}/#/p/${ref}/${tabName}`);
      await p.waitForFunction((n) => document.querySelector(`nav.rail a[data-tab=${n}]`)?.classList.contains("on") && !document.querySelector("#tab-body")?.textContent?.startsWith("Loading"), tabName);
      assert.ok((await overflow()) <= 1, `${tabName} scrolls horizontally by ${await overflow()}px`);
      if (tabName === "overview") await p.screenshot({ path: join(SHOTS, "16-mobile-overview.png"), fullPage: true });
    }
    await m.close();
  });

  step("deletes the project after typed confirmation and returns to the list", async () => {
    await page.goto(`http://127.0.0.1:${apiPort}/#/p/${ref}/settings`);
    await page.waitForSelector("#delete-project");
    await page.click("#delete-project");
    await page.click("dialog button[type=submit]"); // empty confirmation is refused
    await page.waitForSelector("dialog .notice.bad:not([hidden])");
    await page.fill("dialog input[name=typed]", "shop");
    await page.click("dialog button[type=submit]");
    await toast("Project deleted");
    await page.waitForSelector(".empty");
    t.platform.dir.forget(ref); // the gateway caches project state for a couple of seconds
    assert.equal((await rest("/rest/v1/notes")).status, 404);
    await page.click("#avatar");
    await page.click("#signout");
    await page.waitForSelector("#token");
  });
});
