import http from "node:http";
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
import { MemoryMailer } from "../src/mailer.js";
import { makePlatform } from "../src/platform-testkit.js";
import { codeFor, stepAt } from "../src/totp.js";

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
  const mailer = new MemoryMailer();
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
  const SUBS: Record<string, string> = { database: "schema", auth: "users" }; // sections with a second sidebar, and the page each opens on
  const tab = async (id: string, sub?: string) => {
    const section = id === "backups" ? "database" : id;
    const subPage = id === "backups" ? "backups" : sub;
    await page.click(`nav.rail a[data-tab=${section}]`);
    if (SUBS[section] && subPage) await page.click(`nav.sub a[data-dbpage=${subPage}]`);
    const want = SUBS[section] ? `${section}/${subPage ?? SUBS[section]}` : section;
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
    t = await makePlatform(ADMIN!, { publicPort: gwPort, dashboardOrigins: [`http://127.0.0.1:${apiPort}`], ai: { llm: new RuleLlm() }, pipelines: { allowPrivateTargets: true, tickMs: 60_000, backoffBaseMs: 10 }, mail: { mailer }, auth: { emailCooldownMs: 0 } });
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
    await page.waitForSelector(".schema-table[data-table=notes]");
    assert.match((await page.textContent(".schema-table[data-table=notes]"))!, /id\s*bigint[\s\S]*body\s*text[\s\S]*pinned\s*boolean/);
    assert.match((await page.textContent(".legend"))!, /Primary key[\s\S]*Identity[\s\S]*Unique[\s\S]*Nullable[\s\S]*Non-Nullable/);
    // Relationship lines: one per foreign key, following the cards when they are dragged.
    await t.sql(owner, ref, "create table public.note_tags (id bigint primary key generated always as identity, note_id bigint references public.notes(id), tag text)");
    await tab("database", "tables");
    await tab("database", "schema");
    await page.waitForSelector(".schema-table[data-table=note_tags]");
    const rel = "g.rel[data-rel='note_tags.note_id>notes.id'] path";
    await page.waitForSelector(rel);
    assert.equal(await page.locator("g.rel").count(), 1);
    const before = await page.getAttribute(rel, "d");
    const box = (await page.locator(".schema-table[data-table=note_tags] .st-head").boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 140, { steps: 6 });
    await page.mouse.up();
    assert.notEqual(await page.getAttribute(rel, "d"), before, "the line follows the dragged card");
    await page.click("#auto-layout");
    assert.equal(await page.getAttribute(rel, "d"), before, "auto layout restores the default positions");
    await page.fill("#schema-find", "note_tags");
    assert.match((await page.getAttribute(".schema-table[data-table=notes]", "class"))!, /dim/);
    await page.fill("#schema-find", "");
    await page.click("#zoom-out");
    assert.equal(await page.textContent("#zoom-label"), "90%");
    await page.click("#zoom-fit");
    await page.click(".schema-table[data-table=notes] button[aria-label='Row actions']");
    assert.equal(await page.locator(".menu [data-action=view-table]").count(), 1);
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await shot("06d-db-schema");
    await t.sql(owner, ref, "drop table public.note_tags");
    await tab("database", "tables");
    await page.waitForSelector("#catalog-table tr[data-row=notes]");
    assert.match((await page.textContent("nav.sub"))!, /Database management[\s\S]*Schema Visualizer[\s\S]*Tables[\s\S]*Functions[\s\S]*Triggers[\s\S]*Enumerated Types[\s\S]*Extensions[\s\S]*Indexes[\s\S]*Publications[\s\S]*Access control[\s\S]*Policies[\s\S]*Roles[\s\S]*Configuration[\s\S]*Settings[\s\S]*Platform[\s\S]*Backups/);
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
    await page.locator("tr[data-row='anyone reads'] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=definition]");
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

  step("edits policies, triggers, indexes and enum types from the database pages", async () => {
    await t.sql(owner, ref, "create table public.todos (id serial primary key, user_id uuid, title text); grant select, insert on public.todos to anon, authenticated; create function public.shout() returns trigger language plpgsql as $$ begin new.title := upper(new.title); return new; end $$");
    const signup = async (email: string) => (await t.gw(ref, "POST", "/auth/v1/signup", { key: anon, body: { email, password: "password-123" } })).json.user.id as string;
    const ann = await signup("editor-ann@example.com"), bob = await signup("editor-bob@example.com");
    await t.sql(owner, ref, `insert into public.todos (user_id, title) values ('${ann}', 'ann todo'), ('${bob}', 'bob todo')`);

    // ---- policies ----
    await tab("database", "policies");
    await page.click("#new-policy");
    await page.waitForSelector("dialog.sheet #pol-name");
    await page.selectOption("#pol-table", "todos");
    await page.selectOption("#pol-template", "own_read");
    assert.equal(await page.inputValue("#pol-using"), "auth.uid() = user_id", "the template finds the owner column");
    assert.equal(await page.inputValue("#pol-cmd"), "SELECT");
    assert.equal(await page.isVisible("#pol-check"), false, "a select policy has no check expression");
    assert.match((await page.textContent("#pol-rls-note"))!, /Row-level security is off/);
    const preview = (await page.textContent("#sql-preview"))!;
    assert.match(preview, /alter table "public"\."todos" enable row level security;\ncreate policy "Users can only read their own rows" on "public"\."todos"\n  as permissive for select to authenticated\n  using \(auth\.uid\(\) = user_id\);/);
    await page.fill("#pol-name", "");
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    assert.match((await page.textContent("dialog .notice.bad"))!, /name/);
    await page.fill("#pol-name", "owners read");
    await page.fill("#pol-using", "auth.uid() = user_id; drop table todos");
    await page.click("dialog button[type=submit]");
    assert.match((await page.textContent("dialog .notice.bad"))!, /single expression/);
    await page.fill("#pol-using", "auth.uid() = user_id");
    await shot("06j-policy-editor");
    await page.click("dialog button[type=submit]");
    await toast("Policy created");
    await page.waitForSelector("tr[data-row='owners read']");
    assert.equal((await t.sql(owner, ref, "select relrowsecurity from pg_class where relname = 'todos'")).json.results[0].rows[0][0], true, "row-level security was turned on");

    // ---- test access ----
    await page.click("#test-access");
    await page.selectOption("#tst-table", "todos");
    await page.click("#tst-run");
    await page.waitForSelector("#tst-summary");
    assert.match((await page.textContent("#tst-summary"))!, /anonymous visitor can see 0 of 2 rows in todos/);
    await page.selectOption("#tst-who", "user");
    await page.fill("#tst-user-search", "editor-ann");
    await page.click("#tst-user-results [data-user='editor-ann@example.com']");
    await page.click("#tst-run");
    await page.waitForFunction(() => /editor-ann@example\.com can see 1 of 2/.test(document.querySelector("#tst-summary")?.textContent ?? ""));
    assert.match((await page.textContent("#tst-sample"))!, /ann todo/);
    assert.doesNotMatch((await page.textContent("#tst-sample"))!, /bob todo/);
    await shot("06j-test-access");
    await page.click("dialog button[type=submit]");

    // ---- edit: the policy now also applies to anonymous visitors ----
    await page.locator("tr[data-row='owners read'] .linkish").click();
    await page.waitForSelector("dialog.sheet");
    assert.equal(await page.isDisabled("#pol-table"), true);
    assert.equal(await page.isDisabled("#pol-cmd"), true);
    assert.equal(await page.inputValue("#pol-using"), "(auth.uid() = user_id)");
    await page.check("#pol-roles input[data-role=anon]");
    await page.fill("#pol-using", "true");
    await page.fill("#pol-name", "everyone reads");
    assert.match((await page.textContent("#sql-preview"))!, /alter policy "owners read" on "public"\."todos"\n  to anon, authenticated\n  using \(true\);\nalter policy "owners read" on "public"\."todos" rename to "everyone reads";/);
    await page.click("dialog button[type=submit]");
    await toast("Policy saved");
    await page.waitForSelector("tr[data-row='everyone reads']");
    await page.click("#test-access");
    await page.selectOption("#tst-table", "todos");
    await page.click("#tst-run");
    await page.waitForFunction(() => /anonymous visitor can see 2 of 2/.test(document.querySelector("#tst-summary")?.textContent ?? ""));
    await page.click("dialog button[type=submit]");

    await page.locator("tr[data-row='everyone reads'] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=drop-policy]");
    await page.click("dialog button[type=submit]");
    await toast("Policy deleted");
    await page.waitForFunction(() => !document.querySelector("tr[data-row='everyone reads']"));

    // ---- triggers ----
    await tab("database", "triggers");
    await page.click("#new-trigger");
    await page.waitForSelector("dialog.sheet #trg-name");
    await page.fill("#trg-name", "shout_titles");
    await page.selectOption("#trg-table", "todos");
    await page.selectOption("#trg-timing", "BEFORE");
    await page.selectOption("#trg-fn", "public.shout");
    assert.match((await page.textContent("#sql-preview"))!, /create trigger "shout_titles" before insert\n  on "public"\."todos"\n  for each row\n  execute function "public"\."shout"\(\);/);
    await page.fill("#trg-name", "1 bad");
    await page.click("dialog button[type=submit]");
    assert.match((await page.textContent("dialog .notice.bad"))!, /name/);
    await page.fill("#trg-name", "shout_titles");
    await page.click("dialog button[type=submit]");
    await toast("Trigger created");
    await page.waitForSelector("tr[data-row=shout_titles]");
    assert.equal(await page.locator("tr[data-row=baas_realtime]").count(), 0, "platform triggers are not listed");
    await t.sql(owner, ref, "insert into public.todos (title) values ('quiet')");
    const titles = async () => (await t.sql(owner, ref, "select title from public.todos where title ilike 'quiet' or title ilike 'loud' order by id")).json.results[0].rows.map((r: any) => r[0]);
    assert.deepEqual(await titles(), ["QUIET"], "the trigger runs");
    await page.locator("tr[data-row=shout_titles] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=toggle-trigger]");
    await toast("Trigger disabled");
    await t.sql(owner, ref, "insert into public.todos (title) values ('loud')");
    assert.deepEqual(await titles(), ["QUIET", "loud"], "a disabled trigger does nothing");
    await page.locator("tr[data-row=shout_titles] .linkish").click();
    await page.waitForSelector("dialog.sheet");
    assert.equal(await page.inputValue("#trg-timing"), "BEFORE");
    assert.equal(await page.inputValue("#trg-fn"), "public.shout");
    assert.equal(await page.isChecked("#trg-events input[data-event=INSERT]"), true);
    await page.check("#trg-events input[data-event=UPDATE]");
    await page.click("dialog button[type=submit]");
    await toast("Trigger saved");
    await page.waitForFunction(() => /INSERT, UPDATE/.test(document.querySelector("tr[data-row=shout_titles]")?.textContent ?? ""));
    await page.locator("tr[data-row=shout_titles] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=drop-trigger]");
    await page.fill("dialog input[name=typed]", "shout_titles");
    await page.click("dialog button[type=submit]");
    await toast("Trigger deleted");
    await page.waitForFunction(() => !document.querySelector("tr[data-row=shout_titles]"));

    // ---- indexes ----
    await tab("database", "indexes");
    await page.click("#new-index");
    await page.waitForSelector("dialog.sheet #idx-table");
    await page.selectOption("#idx-table", "todos");
    await page.click("dialog button[type=submit]");
    assert.match((await page.textContent("dialog .notice.bad"))!, /at least one column/);
    await page.selectOption("#idx-add", "title");
    await page.selectOption("#idx-add", "user_id");
    assert.deepEqual(await page.locator("#idx-cols .chip-col").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.col)), ["title", "user_id"]);
    await page.click("#idx-cols [aria-label='Move user_id earlier']");
    await page.check("#idx-unique");
    await page.fill("#idx-name", "todos_user_title_uq");
    assert.match((await page.textContent("#sql-preview"))!, /create unique index "todos_user_title_uq" on "public"\."todos"\n  using btree \("user_id", "title"\);/);
    await page.click("dialog button[type=submit]");
    await toast("Index created");
    await page.waitForSelector("tr[data-row=todos_user_title_uq]");
    assert.match((await page.textContent("tr[data-row=todos_user_title_uq]"))!, /CREATE UNIQUE INDEX[\s\S]*\(user_id, title\)/);
    await page.locator("tr[data-row=todos_pkey] button[aria-label='Row actions']").click();
    assert.equal(await page.isDisabled(".menu [data-action=drop-index]"), true, "an index that backs a constraint cannot be dropped here");
    await page.mouse.click(5, 300);
    await page.locator("tr[data-row=todos_user_title_uq] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=drop-index]");
    await page.fill("dialog input[name=typed]", "todos_user_title_uq");
    await page.click("dialog button[type=submit]");
    await toast("Index deleted");
    await page.waitForFunction(() => !document.querySelector("tr[data-row=todos_user_title_uq]"));

    // ---- enumerated types ----
    await tab("database", "enums");
    await page.click("#new-enum");
    await page.waitForSelector("dialog.sheet #enum-name");
    await page.fill("#enum-name", "mood");
    await page.fill("#enum-values", "sad\nhappy");
    assert.match((await page.textContent("#sql-preview"))!, /create type "public"\."mood" as enum \('sad', 'happy'\);/);
    await page.fill("#enum-values", "sad\nsad");
    await page.click("dialog button[type=submit]");
    assert.match((await page.textContent("dialog .notice.bad"))!, /different/);
    await page.fill("#enum-values", "sad\nhappy");
    await page.click("dialog button[type=submit]");
    await toast("Type created");
    await page.waitForSelector("tr[data-row=mood]");
    await page.locator("tr[data-row=mood] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=add-enum-value]");
    await page.fill("#enum-new-value", "meh");
    await page.selectOption("#enum-where", "before:happy");
    await page.click("dialog button[type=submit]");
    await toast("Value added");
    assert.equal((await t.sql(owner, ref, "select enum_range(null::public.mood)::text")).json.results[0].rows[0][0], "{sad,meh,happy}");
    await page.locator("tr[data-row=mood] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=drop-enum]");
    await page.fill("dialog input[name=typed]", "mood");
    await page.click("dialog button[type=submit]");
    await toast("Type deleted");
    await page.waitForFunction(() => !document.querySelector("tr[data-row=mood]"));
    await t.sql(owner, ref, "drop table public.todos; drop function public.shout(); delete from auth.users where email like 'editor-%'");
  });

  step("creates and edits publications, and changes table privileges for the API roles", async () => {
    await t.sql(owner, ref, "create table public.pubone (id serial primary key); create table public.pubtwo (id serial primary key)");
    await tab("database", "publications");
    await page.click("#new-publication");
    await page.waitForSelector("dialog.sheet #pub-name");
    await page.fill("#pub-name", "1 bad");
    await page.click("dialog button[type=submit]");
    assert.match((await page.textContent("dialog .notice.bad"))!, /name/);
    await page.fill("#pub-name", "my_pub");
    await page.check("#pub-tables input[data-table=pubone]");
    await page.uncheck("#pub-events input[data-event=truncate]");
    assert.match((await page.textContent("#sql-preview"))!, /create publication "my_pub"\n  for table "public"\."pubone"\n  with \(publish = 'insert, update, delete'\);/);
    await page.click("dialog button[type=submit]");
    await toast("Publication created");
    await page.waitForSelector("tr[data-row=my_pub]");
    assert.match((await page.textContent("tr[data-row=my_pub]"))!, /1 table/);

    await page.locator("tr[data-row=my_pub] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=edit-publication]");
    await page.waitForSelector("#pub-tables");
    assert.equal(await page.isChecked("#pub-tables input[data-table=pubone]"), true, "shows the current tables");
    await page.check("#pub-tables input[data-table=pubtwo]");
    await page.uncheck("#pub-events input[data-event=delete]");
    await page.fill("#pub-name", "renamed_pub");
    await page.click("dialog button[type=submit]");
    await toast("Publication saved");
    await page.waitForSelector("tr[data-row=renamed_pub]");
    assert.match((await page.textContent("tr[data-row=renamed_pub]"))!, /2 tables/);
    const row = (await t.sql(owner, ref, "select pubinsert, pubupdate, pubdelete, pubtruncate from pg_publication where pubname = 'renamed_pub'")).json.results[0].rows[0];
    assert.deepEqual(row, [true, true, false, false]);
    await page.locator("tr[data-row=renamed_pub] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=drop-publication]");
    await page.fill("dialog input[name=typed]", "renamed_pub");
    await page.click("dialog button[type=submit]");
    await toast("Publication deleted");
    await page.waitForFunction(() => !document.querySelector("tr[data-row=renamed_pub]"));

    // ---- privileges ----
    await tab("database", "roles");
    await page.click("#edit-privileges");
    await page.waitForSelector("#priv-table");
    const cell = (tbl: string, role: string, k: string) => `#priv-table input[data-cell='${tbl}|${role}|${k}']`;
    assert.equal(await page.isChecked(cell("pubone", "anon", "select")), false, "new tables have no grants");
    await page.click("dialog button[type=submit]");
    assert.match((await page.textContent("dialog .notice.bad"))!, /Nothing has changed/);
    await page.check(cell("pubone", "anon", "select"));
    await page.check(cell("pubone", "authenticated", "select"));
    await page.check(cell("pubone", "authenticated", "insert"));
    assert.match((await page.textContent("#sql-preview"))!, /grant SELECT on "public"\."pubone" to anon;\ngrant SELECT, INSERT on "public"\."pubone" to authenticated;/);
    await shot("06l-privileges");
    await page.click("dialog button[type=submit]");
    await toast("Privileges updated");
    const has = async (role: string, priv: string) => (await t.sql(owner, ref, `select has_table_privilege('${role}', 'public.pubone', '${priv}')`)).json.results[0].rows[0][0];
    assert.deepEqual([await has("anon", "select"), await has("authenticated", "insert"), await has("anon", "insert")], [true, true, false]);
    await page.click("#edit-privileges");
    await page.waitForSelector("#priv-table");
    assert.equal(await page.isChecked(cell("pubone", "authenticated", "insert")), true, "the matrix shows what is granted");
    await page.uncheck(cell("pubone", "authenticated", "insert"));
    await page.uncheck(cell("pubone", "anon", "select"));
    assert.match((await page.textContent("#sql-preview"))!, /revoke SELECT on "public"\."pubone" from anon;\nrevoke INSERT on "public"\."pubone" from authenticated;/);
    await page.click("dialog button[type=submit]");
    await toast("Privileges updated");
    assert.deepEqual([await has("anon", "select"), await has("authenticated", "insert"), await has("authenticated", "select")], [false, false, true]);
    await t.sql(owner, ref, "drop table public.pubone, public.pubtwo");
  });

  step("creates, edits, calls and deletes a database function", async () => {
    await tab("database", "functions");
    await page.waitForSelector("#catalog-table .empty");
    assert.match((await page.textContent(".toolbar"))!, /Return Type[\s\S]*Security[\s\S]*New function/);
    assert.equal(await page.locator("a.docs").count(), 1);
    await page.click("#new-function");
    await page.waitForSelector("dialog.sheet");
    assert.match((await page.textContent("dialog.sheet"))!, /Add a new function[\s\S]*Schema[\s\S]*Name of function[\s\S]*Return type[\s\S]*Arguments[\s\S]*Definition[\s\S]*Advanced settings/);
    assert.equal(await page.textContent(".code-wrap .gutter"), "1\n2\n3", "the definition editor has line numbers");
    await shot("06e-db-function-sheet");

    // A bad name is refused inside the panel, which stays open.
    await page.fill("#fn-name", "1 bad name");
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    assert.match((await page.textContent("dialog .notice.bad"))!, /name/);

    await page.fill("#fn-name", "add_numbers");
    await page.fill("#fn-return", "integer");
    await page.click("#add-arg");
    await page.click("#add-arg");
    const names = page.locator("[data-arg-name]"), types = page.locator("[data-arg-type]");
    await names.nth(0).fill("a"); await types.nth(0).fill("integer");
    await names.nth(1).fill("b"); await types.nth(1).fill("integer");
    await page.click("#fn-advanced summary");
    await page.selectOption("#fn-language", "sql");
    await page.fill("#fn-body", "select a + b;");
    await page.click("dialog button[type=submit]");
    await toast("Function created");
    await page.waitForSelector("tr[data-row=add_numbers]");
    const row = (await page.textContent("tr[data-row=add_numbers]"))!;
    assert.match(row, /Function/);
    assert.match(row, /a integer, b integer/);
    assert.match(row, /integer/);
    assert.match(row, /Invoker/);
    await shot("06e-db-functions");
    const call = async (a: number, b: number) => (await (await rest("/rest/v1/rpc/add_numbers", { method: "POST", body: JSON.stringify({ a, b }) })).json());
    assert.equal(await call(2, 3), 5, "callable through the API");

    // The name opens the same form, filled from the catalog. Saving uses create or replace.
    await page.locator("tr[data-row=add_numbers] .linkish").click();
    await page.waitForSelector("dialog.sheet");
    assert.equal(await page.inputValue("#fn-name"), "add_numbers");
    assert.equal(await page.inputValue("#fn-return"), "integer");
    assert.equal(await page.locator("[data-arg]").count(), 2);
    assert.equal(await page.inputValue("[data-arg-name] >> nth=1"), "b");
    assert.match(await page.inputValue("#fn-body"), /select a \+ b/);
    await page.fill("#fn-body", "select a * b;");
    await page.click("dialog button[type=submit]");
    await toast("Function saved");
    assert.equal(await call(2, 3), 6);

    // A mistake is reported in the panel, which stays open, and changes nothing.
    await page.locator("tr[data-row=add_numbers] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=edit-function]");
    await page.fill("#fn-body", "select nope;");
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    assert.match((await page.textContent("dialog .notice.bad"))!, /nope/);
    await page.click("dialog button:has-text('Cancel')");
    assert.equal(await call(2, 3), 6);

    // Security definer is called out, and the filters find it.
    await page.click("#new-function");
    await page.fill("#fn-name", "secret_sum");
    await page.fill("#fn-return", "integer");
    await page.click("#fn-advanced summary");
    await page.selectOption("#fn-language", "sql");
    await page.selectOption("#fn-security", "definer");
    await page.fill("#fn-body", "select 42;");
    await page.click("dialog button[type=submit]");
    await toast("Function created");
    assert.match((await page.textContent("tr[data-row=secret_sum]"))!, /Definer/);
    await page.selectOption("#filter-security", "Definer");
    assert.equal(await page.locator("#catalog-table tbody tr").count(), 1);
    await page.selectOption("#filter-security", "");
    await page.selectOption("#filter-return", "integer");
    assert.equal(await page.locator("#catalog-table tbody tr").count(), 2);
    await page.selectOption("#filter-return", "");

    // Deleting needs the name typed.
    await page.locator("tr[data-row=add_numbers] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=drop-function]");
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

  step("sends a function idea to Ask AI from the functions page", async () => {
    await tab("database", "functions");
    await page.click("#fn-ai");
    // The assistant is off here; the idea waits until it is turned on.
    await page.waitForSelector("#ai-off");
    await page.click("#ai-enable");
    await page.waitForSelector("dialog");
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("#ai-input");
    assert.equal(await page.inputValue("#ai-input"), "Create a new function for the schema public that does ");
    await page.click("#ai-disable");
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("#ai-off");
  });

  step("has working top-bar controls: switchers, help, command line and feedback", async () => {
    await tab("overview");
    await page.click("#project-switch");
    await page.waitForSelector(`.menu button[data-ref='${ref}']`);
    await page.click(`.menu button[data-ref='${ref}']`);
    await page.click("#branch-switch");
    assert.match((await page.textContent(".menu"))!, /main[\s\S]*production[\s\S]*Preview branches are not part of baas yet/i);
    await page.mouse.click(5, 300);
    await page.click("#org-switch");
    assert.match((await page.textContent(".menu"))!, /e2e-org[\s\S]*All projects/);
    await page.mouse.click(5, 300);
    await page.click("#help-btn");
    assert.match((await page.textContent(".menu"))!, /Documentation[\s\S]*Report a problem[\s\S]*Keyboard shortcuts/);
    await page.click(".menu >> text=Keyboard shortcuts");
    assert.match((await page.textContent("dialog"))!, /Ctrl\/⌘ \+ K[\s\S]*Search pages/);
    await page.click("dialog button[type=submit]");
    await page.click("#cli-btn");
    assert.match((await page.textContent("#cli-snippet"))!, new RegExp(`npx baas link ${ref}`));
    await page.click("dialog button[type=submit]");
    assert.match((await page.getAttribute("#advisors-btn", "href"))!, /\/advisors$/);
    assert.match((await page.getAttribute("#ask-ai-btn", "href"))!, /\/ai$/);

    // Feedback opens a prefilled GitHub issue; nothing is sent from the page itself.
    await page.evaluate(() => { (window as any).__opened = []; window.open = ((u: string) => { (window as any).__opened.push(u); return null; }) as any; });
    await page.click("#feedback-btn");
    await page.fill("#feedback-text", "Love the new layout & the charts");
    await page.click("dialog button[type=submit]");
    const opened: string[] = await page.evaluate(() => (window as any).__opened);
    assert.equal(opened.length, 1);
    assert.match(opened[0]!, /^https:\/\/github\.com\/Malick44\/baas\/issues\/new\?title=.*&body=Love%20the%20new%20layout%20%26%20the%20charts$/);
  });

  step("collapses the database sidebar and remembers it", async () => {
    await tab("database", "tables");
    assert.equal(await page.isVisible("nav.sub"), true);
    await page.click("#toggle-sub");
    assert.equal(await page.isVisible("nav.sub"), false);
    await page.reload();
    await page.waitForSelector("#tab-body[data-page='database/tables']");
    assert.equal(await page.isVisible("nav.sub"), false, "stays collapsed after a reload");
    await page.click("#toggle-sub");
    assert.equal(await page.isVisible("nav.sub"), true);
  });

  step("advisors report risky tables and open the fix in the SQL editor", async () => {
    await t.sql(owner, ref, "create table public.loose (owner_id bigint references public.notes(id), note text)");
    await t.sql(owner, ref, "grant select on public.loose to anon");
    await tab("advisors");
    await page.waitForSelector(".finding[data-check=rls_disabled][data-target='public.loose']");
    assert.match((await page.textContent(".finding[data-check=rls_disabled]"))!, /Error[\s\S]*exposed without row-level security/);
    assert.equal(await page.locator(".finding[data-check=rls_disabled][data-target='public.notes']").count(), 0, "a table with row-level security on is not flagged");
    assert.equal(await page.textContent("#adv-tab-security .count") !== "0", true);
    await page.click("#adv-tab-performance");
    await page.waitForSelector(".finding[data-check=no_pk][data-target='public.loose']");
    await page.waitForSelector(".finding[data-check=fk_no_index][data-target='loose.owner_id']");
    await shot("06f-advisors");
    await page.click("#adv-tab-security");
    await page.click(".finding[data-check=rls_disabled][data-target='public.loose'] [data-action=open-fix]");
    await page.waitForSelector("#sql-input");
    assert.equal(await page.inputValue("#sql-input"), 'alter table public."loose" enable row level security;');
    await t.sql(owner, ref, 'alter table public."loose" enable row level security');
    await tab("advisors");
    await page.waitForFunction(() => !document.querySelector(".finding[data-check=rls_disabled]") || document.querySelector(".finding[data-check=rls_disabled]")?.getAttribute("data-target") !== "public.loose");
    await t.sql(owner, ref, "drop table public.loose");
  });

  step("shows reports per service with a selectable range", async () => {
    await tab("reports");
    await page.waitForSelector("#report-table");
    const api = (await t.api("GET", `/v1/projects/${ref}/metrics?hours=24`, { token: owner })).json;
    assert.equal(Number((await page.textContent("#report-total"))!.replace(/[^\d]/g, "").slice(0, String(api.totals.requests).length)), api.totals.requests);
    assert.deepEqual(await page.locator("#report-table tbody tr td:first-child").allTextContents(), ["REST API", "Auth", "Storage", "Edge Functions", "Realtime"]);
    assert.ok(Number((await page.textContent("#report-table tr[data-service=rest] td:nth-child(2)"))!.replace(/,/g, "")) > 0);
    await page.selectOption("#report-range", "168");
    await page.waitForFunction(() => document.querySelectorAll(".metric[data-service=rest] svg rect").length === 56);
    await shot("06g-reports");
  });

  step("sends row changes to a webhook with a pipeline", async () => {
    const got: { sig: string; raw: string }[] = [];
    let answer = 200;
    const hook = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => { got.push({ sig: String(req.headers["x-baas-signature"]), raw: Buffer.concat(chunks).toString() }); res.statusCode = answer; res.end(answer === 200 ? "ok" : "nope"); });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const hookUrl = `http://127.0.0.1:${(hook.address() as any).port}/hook`;
    try {
      await tab("database", "pipelines");
      assert.match((await page.textContent("nav.sub a[data-dbpage=pipelines]"))!, /Pipelines\s*NEW/);
      await page.waitForSelector("#pipeline-empty");
      await shot("06h-pipelines-empty");

      await page.click("#new-pipeline");
      await page.waitForSelector("dialog.sheet");
      await page.fill("#pl-name", "notes to my server");
      await page.fill("#pl-url", hookUrl);
      await page.click("dialog button[type=submit]");
      await page.locator("dialog .notice.bad:not([hidden])").waitFor();
      assert.match((await page.textContent("dialog .notice.bad"))!, /at least one table/);
      await page.check("#pl-tables input[data-table=notes]");
      await page.uncheck("#pl-events input[data-event=DELETE]");
      await page.click("dialog button[type=submit]");
      await toast("Pipeline created");
      await page.waitForSelector("#verify-snippet");
      const secret = (await page.locator("dialog .kv code").first().textContent()) ?? "";
      assert.equal(secret.includes("•"), true, "the secret starts hidden");
      await page.locator("dialog button:has-text('Reveal')").click();
      const shown = (await page.locator("dialog .kv code").first().textContent())!;
      assert.match(shown, /^whsec_/);
      await page.click("dialog button[type=submit]");
      const row = "tr[data-row='notes to my server']";
      await page.waitForSelector(row);
      assert.equal(await page.getAttribute(`${row} .chip`, "data-status"), "healthy");
      assert.match((await page.textContent(row))!, /notes/);

      // A real change, delivered on demand, signed with the secret that was shown.
      await t.sql(owner, ref, "insert into public.notes (body) values ('from the pipeline test')");
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=run]");
      await page.waitForFunction((r) => document.querySelector(`${r} td[data-delivered]`)?.getAttribute("data-delivered") === "1", row);
      assert.equal(got.length, 1);
      const parsed = JSON.parse(got[0]!.raw);
      assert.equal(parsed.events[0].record.body, "from the pipeline test");
      const m = /t=(\d+),v1=(\w+)/.exec(got[0]!.sig)!;
      const expected = (await import("node:crypto")).createHmac("sha256", shown).update(`${m[1]}.${got[0]!.raw}`).digest("hex");
      assert.equal(m[2], expected, "the signature verifies with the secret from the dialog");
      await shot("06h-pipelines");

      // The delivery log, and a test event.
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=test]");
      await toast("Test event delivered");
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=deliveries]");
      await page.waitForSelector("#delivery-table");
      const kinds = await page.locator("#delivery-table tbody tr td:nth-child(2)").allTextContents();
      assert.deepEqual(kinds, ["Test", "Changes"]);
      await page.click("dialog button[type=submit]");

      // A failing destination shows as failing, with the reason on hover, and recovers.
      answer = 500;
      await t.sql(owner, ref, "insert into public.notes (body) values ('will fail first')");
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=run]");
      await page.waitForFunction((r) => document.querySelector(`${r} .chip`)?.getAttribute("data-status") === "failing", row);
      assert.match((await page.getAttribute(`${row} .chip`, "title"))!, /500/);
      answer = 200;
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=run]");
      await page.waitForFunction((r) => document.querySelector(`${r} .chip`)?.getAttribute("data-status") === "healthy", row);

      // Pause, resume, rotate.
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=toggle]");
      await page.waitForFunction((r) => document.querySelector(`${r} .chip`)?.getAttribute("data-status") === "paused", row);
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=toggle]");
      await page.waitForFunction((r) => document.querySelector(`${r} .chip`)?.getAttribute("data-status") === "healthy", row);
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=rotate]");
      await page.click("dialog button[type=submit]");
      await page.waitForSelector("#verify-snippet");
      await page.locator("dialog button:has-text('Reveal')").click();
      assert.notEqual((await page.locator("dialog .kv code").first().textContent())!, shown);
      await page.click("dialog button[type=submit]");

      // Only matching rows: add a condition through the editor.
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=edit]");
      await page.waitForSelector("#pl-filters .filter-block[data-table=notes]");
      assert.match((await page.textContent("#pl-filters"))!, /Every row is sent/);
      await page.click("#pl-filters [data-action=add-cond]");
      await page.selectOption("#pl-filters .cond-col", "body");
      await page.selectOption("#pl-filters .cond-op", "eq");
      await page.click("dialog button[type=submit]");
      await page.locator("dialog .notice.bad:not([hidden])").waitFor();
      assert.match((await page.textContent("dialog .notice.bad"))!, /Give a value for the condition on notes\.body/);
      await page.fill("#pl-filters .cond-val", "match me");
      await shot("06h-pipeline-filter");
      await page.click("dialog button[type=submit]");
      await toast("Pipeline saved");
      await page.waitForFunction((r) => /notes \(filtered\)/.test(document.querySelector(r)?.textContent ?? ""), row);
      got.length = 0;
      await t.sql(owner, ref, "insert into public.notes (body) values ('other'), ('match me'), ('match me too')");
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=run]");
      for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(got.flatMap((g) => JSON.parse(g.raw).events).map((e: any) => e.record.body), ["match me"], "only the matching row is sent");
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=edit]");
      await page.waitForSelector("#pl-filters .cond-val");
      assert.equal(await page.inputValue("#pl-filters .cond-val"), "match me", "the condition is shown again when editing");
      await page.click("#pl-filters [aria-label='Remove condition']");
      await page.click("dialog button[type=submit]");
      await toast("Pipeline saved");
      await page.waitForFunction((r) => !/filtered/.test(document.querySelector(r)?.textContent ?? ""), row);

      // Delete needs the name typed.
      await page.locator(`${row} button[aria-label='Row actions']`).click();
      await page.click(".menu [data-action=delete]");
      await page.click("dialog button[type=submit]");
      await page.locator("dialog .notice.bad:not([hidden])").waitFor();
      await page.fill("dialog input[name=typed]", "notes to my server");
      await page.click("dialog button[type=submit]");
      await page.waitForSelector("#pipeline-empty");
    } finally {
      hook.close();
    }
  });

  step("shows what the project connects to and installs Postgres extensions", async () => {
    await tab("integrations");
    await page.waitForSelector(".service-card[data-service=pipelines]");
    assert.deepEqual(await page.locator(".service-card strong").allTextContents(), ["Ask AI", "Pipelines", "Edge Functions", "Realtime", "Storage"]);
    assert.match((await page.textContent(".service-card[data-service=pipelines]"))!, /None/);
    await page.click(".service-card[data-service=pipelines]");
    await page.waitForFunction(() => document.querySelector("#tab-body")?.getAttribute("data-page") === "database/pipelines");
    await tab("integrations");
    await page.waitForSelector(".ext-card[data-ext=pg_trgm]");
    await shot("06i-integrations");
    assert.match((await page.textContent(".ext-card[data-ext=pgcrypto]"))!, /Installed/);
    assert.equal(await page.isDisabled(".ext-card[data-ext=pgcrypto] button"), true, "the platform's own extension cannot be removed");

    await page.fill("#ext-search", "trigram");
    assert.equal(await page.locator(".ext-card").count(), 1);
    await page.click(".ext-card[data-ext=pg_trgm] [data-action=install]");
    await toast("pg_trgm installed");
    assert.match((await page.textContent(".ext-card[data-ext=pg_trgm]"))!, /Installed[\s\S]*extensions/);
    assert.equal((await t.sql(owner, ref, "select extensions.similarity('abc', 'abd')")).status, 200);
    await page.fill("#ext-search", "");
    await page.selectOption("#ext-filter", "installed");
    assert.equal(await page.locator(".ext-card[data-ext=pg_trgm]").count(), 1);
    assert.equal(await page.locator(".ext-card:not(.on)").count(), 0);
    await page.selectOption("#ext-filter", "all");

    await page.fill("#ext-search", "pg_trgm");
    await page.click(".ext-card[data-ext=pg_trgm] [data-action=remove]");
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    await page.fill("dialog input[name=typed]", "pg_trgm");
    await page.click("dialog button[type=submit]");
    await toast("pg_trgm removed");
    await page.waitForSelector(".ext-card[data-ext=pg_trgm] [data-action=install]");
  });

  step("configures sign-in providers and URLs", async () => {
    await tab("auth", "providers");
    await page.waitForSelector("#provider-table");
    assert.deepEqual(await page.locator("#provider-table tbody tr td:first-child").allTextContents(), ["Email", "Phone", "Google", "GitHub", "GitLab", "Discord", "Microsoft"]);
    assert.match((await page.textContent("#callback-note"))!, new RegExp(`http://${ref}\\.localhost:${gwPort}/auth/v1/callback`));
    await shot("06k-auth-providers");

    // A provider needs both halves of its credentials before it can be switched on.
    await page.click("tr[data-row=google] [data-action=configure]");
    await page.waitForSelector("#prov-client-id");
    await page.check("#prov-enabled");
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    assert.match((await page.textContent("dialog .notice.bad"))!, /needs a client id and a client secret/);
    await page.click("dialog button:has-text('Cancel')");

    await page.click("tr[data-row=github] [data-action=configure]");
    assert.match((await page.textContent("dialog"))!, /Developer settings/);
    await page.check("#prov-enabled");
    await page.fill("#prov-client-id", "gh-client");
    await page.fill("#prov-secret", "super-secret-value");
    await page.click("dialog button[type=submit]");
    await toast("GitHub saved");
    await page.waitForFunction(() => document.querySelector("tr[data-row=github] .chip")?.getAttribute("data-status") === "enabled");
    assert.match((await page.textContent("tr[data-row=github]"))!, /gh-client/);
    await page.click("tr[data-row=github] [data-action=configure]");
    assert.match((await page.getAttribute("#prov-secret", "placeholder"))!, /A secret is saved/);
    assert.equal(await page.inputValue("#prov-secret"), "", "the secret is never sent back to the page");
    await page.click("dialog button:has-text('Cancel')");
    const stored = await t.api("GET", `/v1/projects/${ref}/settings`, { token: owner });
    assert.ok(!stored.text.includes("super-secret-value"));
    assert.deepEqual(stored.json.auth_providers.github, { enabled: true, client_id: "gh-client", secret_set: true });
    t.platform.dir.forget(ref);
    assert.equal((await (await rest("/auth/v1/settings")).json()).external.github, true);
    await page.click("tr[data-row=github] [data-action=configure]");
    await page.uncheck("#prov-enabled");
    await page.click("dialog button[type=submit]");
    await toast("GitHub saved");
    await page.waitForFunction(() => document.querySelector("tr[data-row=github] .chip")?.getAttribute("data-status") === "disabled");

    // ---- where emailed links and sign-ins may return to ----
    await tab("auth", "urls");
    await page.fill("#auth-site-url", "ftp://nope");
    await page.click("#save-urls");
    await toast("invalid value for site_url");
    await page.fill("#auth-site-url", "https://app.example.com");
    await page.fill("#auth-redirects", "https://preview.example.com/*\nmyapp://callback");
    await page.click("#save-urls");
    await toast("URL configuration saved");
    const s = (await t.api("GET", `/v1/projects/${ref}/settings`, { token: owner })).json;
    assert.equal(s.site_url, "https://app.example.com");
    assert.deepEqual(s.redirect_urls, ["https://preview.example.com/*", "myapp://callback"]);
    await page.reload();
    await page.waitForSelector("#auth-redirects");
    assert.equal(await page.inputValue("#auth-site-url"), "https://app.example.com");
    assert.match(await page.inputValue("#auth-redirects"), /myapp:\/\/callback/);
    await shot("06k-auth-urls");

    // Browser origins: restricting them must not lock the dashboard itself out.
    await page.fill("#auth-cors", "https://only-this.example.com");
    await page.click("#save-urls");
    await toast("URL configuration saved");
    t.platform.dir.forget(ref);
    const preflight = (origin: string) => dnsFetch(`http://${ref}.localhost:${gwPort}/rest/v1/`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
    assert.equal((await preflight("https://only-this.example.com")).headers.get("access-control-allow-origin"), "https://only-this.example.com");
    assert.equal((await preflight("https://elsewhere.example.com")).headers.get("access-control-allow-origin"), null);
    assert.equal((await preflight(`http://127.0.0.1:${apiPort}`)).headers.get("access-control-allow-origin"), `http://127.0.0.1:${apiPort}`, "the dashboard's own origin is always allowed");
    await tab("auth", "users");
    await page.waitForSelector("#users");
    await tab("auth", "urls");
    await page.fill("#auth-cors", "");
    await page.click("#save-urls");
    await toast("URL configuration saved");
    t.platform.dir.forget(ref);
    assert.equal((await preflight("https://elsewhere.example.com")).headers.get("access-control-allow-origin"), "*");
  });


  step("adds, edits and removes a custom OpenID Connect provider", async () => {
    await tab("auth", "providers");
    await page.waitForSelector("#add-oidc");
    await page.click("#add-oidc");
    await page.fill("#oidc-id", "acme-sso");
    await page.fill("#oidc-label", "Acme SSO");
    await page.fill("#oidc-issuer", "https://login.example.com");
    await page.fill("#oidc-client-id", "acme-client");
    await page.fill("#oidc-scopes", "email profile");
    await page.click("dialog button[type=submit]");
    await page.locator("dialog .notice.bad:not([hidden])").waitFor();
    assert.match((await page.textContent("dialog .notice.bad"))!, /invalid value for oidc_providers/);
    await page.fill("#oidc-scopes", "openid email profile");
    await page.click("dialog button[type=submit]");
    await page.waitForFunction(() => /needs an issuer/.test(document.querySelector("dialog .notice.bad")?.textContent ?? ""));
    await page.fill("#oidc-secret", "oidc-super-secret");
    await page.click("dialog button[type=submit]");
    await toast("Provider saved");
    await page.waitForSelector("tr[data-row=acme-sso][data-custom]");
    assert.match((await page.textContent("tr[data-row=acme-sso]"))!, /Acme SSO\s*OIDC\s*Enabled\s*acme-client/);
    assert.ok(!(await t.api("GET", `/v1/projects/${ref}/settings`, { token: owner })).text.includes("oidc-super-secret"));
    t.platform.dir.forget(ref);
    assert.equal((await (await rest("/auth/v1/settings")).json()).external["acme-sso"], true);

    await page.click("tr[data-row=acme-sso] [data-action=configure]");
    assert.equal(await page.isDisabled("#oidc-id"), true, "the name cannot change once created");
    assert.match((await page.getAttribute("#oidc-secret", "placeholder"))!, /A secret is saved/);
    await page.uncheck("#oidc-enabled");
    await page.click("dialog button[type=submit]");
    await page.waitForFunction(() => document.querySelector("tr[data-row=acme-sso] .chip[data-status]")?.getAttribute("data-status") === "disabled");
    await shot("06l-custom-oidc");

    await page.click("tr[data-row=acme-sso] [data-action=remove-provider]");
    await page.click("dialog button[type=submit]");
    await page.locator("tr[data-row=acme-sso]").waitFor({ state: "detached" });
    t.platform.dir.forget(ref);
    assert.equal((await (await rest("/auth/v1/settings")).json()).external["acme-sso"], undefined);
  });
  step("manages confirmation emails, templates and the email actions on users", async () => {
    await tab("auth", "email");
    await page.waitForSelector("#mail-on");
    await page.fill("#auth-from-name", "Shop team");
    await page.selectOption("#tpl-kind", "recovery");
    assert.match(await page.inputValue("#tpl-subject"), /Reset your password/, "shows the default until it is changed");
    await page.fill("#tpl-subject", "Choose a new password for Shop");
    await page.selectOption("#tpl-kind", "confirmation");
    assert.match(await page.inputValue("#tpl-subject"), /Confirm your email address/, "each template keeps its own text");
    await page.selectOption("#tpl-kind", "recovery");
    assert.equal(await page.inputValue("#tpl-subject"), "Choose a new password for Shop", "switching back keeps the edit");
    await page.check("#auth-email-confirm");
    await page.click("#save-email");
    await toast("Email settings saved");
    t.platform.dir.forget(ref);
    const saved = (await t.api("GET", `/v1/projects/${ref}/settings`, { token: owner })).json;
    assert.equal(saved.email_confirm, true);
    assert.equal(saved.mailer_from_name, "Shop team");
    assert.equal(saved.email_templates.recovery.subject, "Choose a new password for Shop");
    assert.equal(saved.email_templates.confirmation.subject, "", "an unchanged template stays on the default");
    await shot("06k-auth-email");

    // Sign-ups now need confirming; the dashboard shows who has not.
    const su = await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: "pending@example.com", password: "secret123" }) });
    assert.equal((await su.json()).access_token, undefined);
    assert.match(mailer.last("pending@example.com")!.text, /\/auth\/v1\/verify\?token=/);
    await tab("auth", "users");
    await page.waitForSelector("#users tr[data-email='pending@example.com'] [data-status=unconfirmed]");
    await page.locator("#users tr[data-email='pending@example.com'] button[aria-label='Row actions']").click();
    const items = await page.locator(".menu button").allTextContents();
    assert.deepEqual(items, ["Send password recovery", "Send magic link", "Resend confirmation email", "Mark email as confirmed"]);
    await page.click(".menu [data-action=send-recovery]");
    await toast("Recovery email sent to pending@example.com");
    assert.equal(mailer.last("pending@example.com")!.subject, "Choose a new password for Shop", "the template is used");
    assert.equal(mailer.last("pending@example.com")!.fromName, "Shop team");
    await page.locator("#users tr[data-email='pending@example.com'] button[aria-label='Row actions']").click();
    await page.click(".menu [data-action=confirm-email]");
    await toast("Email confirmed");
    await page.waitForFunction(() => !document.querySelector("#users tr[data-email='pending@example.com'] [data-status=unconfirmed]"));
    assert.equal((await rest("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: "pending@example.com", password: "secret123" }) })).status, 200);
    await t.sql(owner, ref, "delete from auth.users where email = 'pending@example.com'");

    // A user created in the dashboard can be left unconfirmed.
    await page.click("#new-user");
    await page.fill("#user-email", "manual@example.com");
    await page.fill("#user-password", "secret123");
    await page.uncheck("#user-confirm");
    await page.click("dialog button[type=submit]");
    await toast("User created");
    await page.waitForSelector("#users tr[data-email='manual@example.com'] [data-status=unconfirmed]");
    await t.sql(owner, ref, "delete from auth.users where email = 'manual@example.com'");

    // Back to the default so later steps sign up as before; a reset template returns to the default text.
    await tab("auth", "email");
    await page.uncheck("#auth-email-confirm");
    await page.selectOption("#tpl-kind", "recovery");
    await page.click("#reset-template");
    assert.match(await page.inputValue("#tpl-subject"), /Reset your password/);
    await page.click("#save-email");
    await toast("Email settings saved");
    t.platform.dir.forget(ref);
    assert.equal((await t.api("GET", `/v1/projects/${ref}/settings`, { token: owner })).json.email_templates.recovery.subject, "");
  });

  step("shows who has an authenticator and removes a lost one", async () => {
    const { codeFor, stepAt } = await import("../src/totp.js");
    const email = "mfa-user@example.com";
    const su = await (await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password: "secret123" }) })).json();
    const call = async (path: string, token: string, body: unknown = {}) => (await rest(path, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } })).json();
    const factor = await call("/auth/v1/factors", su.access_token);
    const challenge = await call(`/auth/v1/factors/${factor.id}/challenge`, su.access_token);
    const upgraded = await call(`/auth/v1/factors/${factor.id}/verify`, su.access_token, { challenge_id: challenge.id, code: codeFor(factor.totp.secret, stepAt(Date.now())) });
    assert.ok(upgraded.access_token);

    await tab("auth", "users");
    await page.waitForSelector(`#users tr[data-email='${email}'] [data-mfa=on]`);
    assert.equal(await page.locator("#users [data-mfa=on]").count(), 1, "only the user who set one up");
    await shot("07-users-mfa");
    await page.locator(`#users tr[data-email='${email}'] button[aria-label='Row actions']`).click();
    await page.click(".menu [data-action=remove-mfa]");
    assert.match((await page.textContent("dialog"))!, /lost their device/);
    await page.click("dialog button[type=submit]");
    await toast("Authenticator removed");
    await page.waitForFunction((e) => !document.querySelector(`#users tr[data-email='${e}'] [data-mfa=on]`), email);
    assert.equal((await rest("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: upgraded.refresh_token }) })).status, 400, "the upgraded session ended");
    await t.sql(owner, ref, `delete from auth.users where email = '${email}'`);
  });

  step("keeps toasts tidy: repeats count up, at most three show, and a click dismisses", async () => {
    await tab("auth", "sessions");
    const save = async (fill: () => Promise<void>) => { await fill(); await page.click("#save-settings"); };
    await save(() => page.fill("#set-minpw", "3"));
    await save(() => page.fill("#set-minpw", "3"));
    await page.waitForSelector(".toast.bad[data-msg='invalid value for password_min_length']");
    // The second response can arrive a moment after the first on a fast machine, so wait for the count instead of reading it once.
    await page.waitForFunction(() => /×2/.test(document.querySelector(".toast.bad[data-msg='invalid value for password_min_length']")?.textContent ?? ""), null, { timeout: 5000 });
    assert.equal(await page.locator(".toast.bad[data-msg='invalid value for password_min_length']").count(), 1);
    await page.fill("#set-minpw", "6");
    await save(() => page.fill("#set-expiry", "10"));
    await toast("invalid value for jwt_expiry");
    await page.fill("#set-expiry", "900");
    await tab("auth", "urls");
    await page.fill("#auth-site-url", "ftp://nope");
    await page.click("#save-urls");
    await toast("invalid value for site_url");
    await tab("auth", "email");
    await page.fill("#auth-from-name", "a<b");
    await page.click("#save-email");
    await toast("invalid value for mailer_from_name");
    assert.equal(await page.locator(".toast").count(), 3, "never more than three");
    assert.equal(await page.locator(".toast[data-msg='invalid value for password_min_length']").count(), 0, "the oldest made room");
    await shot("17-toasts");
    await page.locator(".toast").first().click();
    assert.equal(await page.locator(".toast").count(), 2, "a click dismisses one");
    await page.fill("#auth-from-name", "");
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
    /** Click save and wait for the server to answer, so a toast left over from an earlier save cannot satisfy the wait. */
    const saveSettings = async (status = 200) => {
      const [res] = await Promise.all([page.waitForResponse((r) => /\/settings$/.test(r.url()) && r.request().method() === "PATCH"), page.click("#save-settings")]);
      assert.equal(res.status(), status);
    };
    await tab("auth", "sessions");
    await page.fill("#set-expiry", "900");
    await page.check("#set-disable");
    await saveSettings();
    t.platform.dir.forget(ref);
    const su = await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: "late@example.com", password: "secret123" }) });
    assert.equal(su.status, 422);
    await page.uncheck("#set-disable");
    await saveSettings();
    t.platform.dir.forget(ref);
    const ok = await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: "late@example.com", password: "secret123" }) });
    assert.equal((await ok.json()).expires_in, 900);
    await page.fill("#set-minpw", "3");
    await saveSettings(400);
    await toast("invalid value for password_min_length");
    await page.fill("#set-minpw", "8");
    await saveSettings();
    t.platform.dir.forget(ref);
    const short = await rest("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: "short@example.com", password: "secret1" }) });
    assert.equal(short.status, 422);
    await page.fill("#set-minpw", "6");
    await saveSettings();
    t.platform.dir.forget(ref);

    await tab("settings");
    await page.fill("#set-env", "GREETING=hola");
    await saveSettings();
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

  step("invites a teammate who signs in with a password, and manages the team", async () => {
    const base = `http://127.0.0.1:${apiPort}`;
    await page.goto(`${base}/#/team`);
    await page.waitForSelector("#team");
    assert.match((await page.textContent("#no-members"))!, /Nobody has a member account/);
    await page.click("#invite-member");
    await page.fill("#invite-email", "newbie@example.com");
    await page.selectOption("#invite-role", "developer");
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("#invite-link code");
    const link = (await page.textContent("#invite-link code"))!;
    assert.match(link, /#\/invite\/baasinv_/);
    await page.click("dialog button[type=submit]");
    await page.waitForSelector("tr[data-invite='newbie@example.com']");
    await shot("team-invited");

    // The invited person, in a fresh browser profile.
    const fresh = await browser.newContext();
    const np = await fresh.newPage();
    np.on("pageerror", (e) => problems.push(`member pageerror: ${e.message}`));
    await np.goto(link);
    await np.waitForSelector("#invite-form");
    await np.fill("#invite-password", "newbie-password-1");
    await np.fill("#invite-confirm", "different-password");
    await np.click("#accept-invite");
    await np.locator("#invite-error:not([hidden])").waitFor();
    assert.match((await np.textContent("#invite-error"))!, /do not match/);
    await np.fill("#invite-name", "Newbie");
    await np.fill("#invite-confirm", "newbie-password-1");
    await np.click("#accept-invite");
    await np.waitForSelector("#project-grid");
    await np.click("#avatar");
    assert.match((await np.textContent("#who"))!, /newbie@example\.com\s*e2e-org\s*developer/);
    assert.equal(await np.locator("#menu-team").count(), 0, "a developer has no team page");
    await np.goto(`${base}/#/team`);
    await np.waitForSelector(".empty");
    assert.match((await np.textContent("main"))!, /requires the admin role/);

    // Changing the password signs out other devices; the new one works on the sign-in page.
    await np.reload();
    await np.click("#avatar");
    await np.click("#menu-password");
    await np.fill("#pw-current", "wrong-password");
    await np.fill("#pw-new", "newbie-password-2");
    await np.fill("#pw-again", "newbie-password-2");
    await np.click("dialog button[type=submit]");
    await np.locator("dialog .notice.bad:not([hidden])").waitFor();
    await np.fill("#pw-current", "newbie-password-1");
    await np.click("dialog button[type=submit]");
    await np.locator("#toasts .toast.ok", { hasText: "Password changed" }).waitFor();
    await np.click("#avatar");
    await np.click("#signout");
    await np.waitForSelector("#member-form");
    await np.fill("#login-email", "newbie@example.com");
    await np.fill("#login-password", "newbie-password-1");
    await np.click("#signin-member");
    await np.locator("#member-error:not([hidden])").waitFor();
    assert.match((await np.textContent("#member-error"))!, /invalid email or password/);
    await np.fill("#login-password", "newbie-password-2");
    await np.click("#signin-member");
    await np.waitForSelector("#project-grid");

    // The owner sees the member, changes the role, then removes them: their session ends at once.
    await page.reload();
    await page.waitForSelector("tr[data-member='newbie@example.com']");
    assert.equal(await page.locator("tr[data-invite]").count(), 0, "the invitation is used up");
    await page.locator("tr[data-member='newbie@example.com'] button[aria-label='Row actions']").click();
    await page.click("[data-action=member-role]");
    await page.selectOption("#role-select", "admin");
    await page.click("dialog button[type=submit]");
    await page.locator("tr[data-member='newbie@example.com']", { hasText: "admin" }).waitFor();
    await np.reload();
    await np.waitForSelector("#project-grid");
    await np.click("#avatar");
    await np.waitForSelector("#menu-team");
    await shot("team");
    await page.locator("tr[data-member='newbie@example.com'] button[aria-label='Row actions']").click();
    await page.click("[data-action=member-remove]");
    await page.click("dialog button[type=submit]");
    await page.locator("tr[data-member='newbie@example.com']").waitFor({ state: "detached" });
    await np.goto(`${base}/#/projects`);
    await np.reload();
    await np.waitForSelector("#member-form");
    await fresh.close();
    await page.goto(`${base}/#/projects`);
    await page.waitForSelector("#project-grid");
  });

  step("members turn on two-step verification, recover by email, and an owner can reset a lost device", async () => {
    const base = `http://127.0.0.1:${apiPort}`;
    const inv = await t.api("POST", "/v1/members/invites", { token: owner, body: { email: "secure@example.com", role: "developer" } });
    const fresh = await browser.newContext();
    const np = await fresh.newPage();
    np.on("pageerror", (e) => problems.push(`secure pageerror: ${e.message}`));
    await np.goto(`${base}/#/invite/${inv.json.token}`);
    await np.fill("#invite-password", "secure-password-1");
    await np.fill("#invite-confirm", "secure-password-1");
    await np.click("#accept-invite");
    await np.waitForSelector("#project-grid");

    // Turn it on: key, then a code from it, then the recovery codes.
    await np.click("#avatar");
    await np.click("#menu-mfa");
    await np.waitForSelector("#mfa-secret code");
    const secret = (await np.locator("#mfa-secret code").first().textContent())!.trim();
    assert.match(secret, /^[A-Z2-7]{20,}$/);
    await np.fill("#mfa-code", "000000");
    await np.click("dialog button[type=submit]");
    await np.waitForFunction(() => /not right/.test(document.querySelector("dialog .notice.bad")?.textContent ?? ""));
    await np.fill("#mfa-code", codeFor(secret, stepAt(Date.now())));
    await np.click("dialog button[type=submit]");
    await np.waitForSelector("#recovery-codes");
    const recovery = (await np.textContent("#recovery-codes"))!.trim().split("\n");
    assert.equal(recovery.length, 8);
    await shot("member-recovery-codes");
    await np.click("dialog button[type=submit]");
    await np.reload();
    await np.click("#avatar");
    await np.click("#menu-mfa");
    await np.waitForSelector("#mfa-state");
    await np.click("dialog button:has-text('Cancel')");

    // Signing in now asks for a code.
    await np.click("#avatar");
    await np.click("#signout");
    await np.fill("#login-email", "secure@example.com");
    await np.fill("#login-password", "secure-password-1");
    await np.click("#signin-member");
    await np.waitForSelector("#code-form, #member-error:not([hidden])");
    assert.equal(await np.locator("#member-error:not([hidden])").count(), 0, await np.locator("#member-error").textContent().catch(() => "no error element"));
    await np.fill("#login-code", "123456");
    await np.click("#verify-code");
    await np.locator("#code-error:not([hidden])").waitFor();
    await np.fill("#login-code", codeFor(secret, stepAt(Date.now()) + 1));
    await np.click("#verify-code");
    await np.waitForSelector("#project-grid");

    // A recovery code stands in for the app, once.
    await np.click("#avatar");
    await np.click("#signout");
    await np.fill("#login-email", "secure@example.com");
    await np.fill("#login-password", "secure-password-1");
    await np.click("#signin-member");
    await np.fill("#login-code", recovery[0]!);
    await np.click("#verify-code");
    await np.waitForSelector("#project-grid");

    // Forgot the password: the link arrives by email and works once; the second factor still applies afterwards.
    await np.click("#avatar");
    await np.click("#signout");
    await np.waitForSelector("#forgot-password:not([hidden])");
    await np.fill("#login-email", "secure@example.com");
    await np.click("#forgot-password");
    await np.click("dialog button[type=submit]");
    await np.locator("#toasts .toast.ok", { hasText: "a link is on its way" }).waitFor();
    await np.waitForFunction(() => true);
    let link = "";
    for (let i = 0; i < 40 && !link; i++) { link = /http:\/\/[^\s]+\/#\/reset\/baasrst_[\w-]+/.exec(mailer.last("secure@example.com")?.text ?? "")?.[0] ?? ""; if (!link) await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(link, "a reset email was sent");
    await np.goto(link);
    await np.reload();
    await np.waitForSelector("#reset-form");
    await np.fill("#reset-new", "brand-new-password-2");
    await np.fill("#reset-again", "something-else-entirely");
    await np.click("#do-reset");
    await np.locator("#reset-error:not([hidden])").waitFor();
    await np.fill("#reset-again", "brand-new-password-2");
    await np.click("#do-reset");
    await np.waitForSelector("#member-form");
    await np.fill("#login-email", "secure@example.com");
    await np.fill("#login-password", "brand-new-password-2");
    await np.click("#signin-member");
    await np.waitForSelector("#code-form");

    // They lost the device and the codes: the owner removes the authenticator.
    await page.goto(`${base}/#/team`);
    await page.reload();
    await page.waitForSelector("tr[data-member='secure@example.com'] [data-mfa=on]");
    await page.locator("tr[data-member='secure@example.com'] button[aria-label='Row actions']").click();
    await page.click("[data-action=member-remove-mfa]");
    await page.click("dialog button[type=submit]");
    await page.locator("tr[data-member='secure@example.com'] [data-mfa=on]").waitFor({ state: "detached" });
    await np.click("button:has-text('Back')");
    await np.fill("#login-email", "secure@example.com");
    await np.fill("#login-password", "brand-new-password-2");
    await np.click("#signin-member");
    await np.waitForSelector("#project-grid");
    await fresh.close();
    await page.goto(`${base}/#/projects`);
    await page.waitForSelector("#project-grid");
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
    for (const tabName of ["overview", "tables", "sql", "settings", "database/pipelines", "integrations", "advisors", "auth/providers", "auth/email", "auth/urls", "auth/sessions", "database/roles", "database/publications"]) {
      await p.goto(`http://127.0.0.1:${apiPort}/#/p/${ref}/${tabName}`);
      await p.waitForFunction((n) => document.querySelector(`nav.rail a[data-tab=${n.split("/")[0]}]`)?.classList.contains("on") && !document.querySelector("#tab-body")?.textContent?.startsWith("Loading"), tabName);
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
