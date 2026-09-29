import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runCli } from "./cli.js";
import { Scripted, propose, query, text } from "./ai-testkit.js";
import { makePlatform, PG_BIN } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("cli", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let apiUrl: string;
  let owner: string;
  let cwd: string;
  let cfg: string;

  const fake = new Scripted();
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { BAAS_CONFIG_DIR: cfg } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  before(async () => {
    t = await makePlatform(ADMIN!, { ai: { llm: fake } });
    const ports = await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
    apiUrl = `http://127.0.0.1:${ports.api}`;
    owner = await t.org();
    cwd = await mkdtemp(join(tmpdir(), "baas-cli-"));
    cfg = join(cwd, "config");
  });
  after(() => t?.close());

  it("refuses to do anything before login, and rejects bad credentials", async () => {
    const r = await run("projects", "list");
    assert.equal(r.code, 1);
    assert.match(r.err, /not logged in/);
    assert.equal((await run("login", "--url", apiUrl, "--token", "wrong")).code, 1);
    assert.equal((await run("login", "--url", "ftp://x", "--token", "a")).code, 1);
  });

  it("logs in and stores the token privately", async () => {
    const r = await run("login", "--url", apiUrl, "--token", owner);
    assert.equal(r.code, 0);
    assert.match(r.out, /Logged in/);
    const mode = (await stat(join(cfg, "config.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.match((await run("whoami")).out, /0 projects/);
  });

  let ref: string;
  it("creates, lists and links a project", async () => {
    const c = await run("projects", "create", "cli-app");
    assert.equal(c.code, 0);
    ref = /\(([a-z0-9]{20})\)/.exec(c.out)![1]!;
    t.refs.push(ref);
    assert.match((await run("projects", "list")).out, new RegExp(`${ref}\\s+cli-app\\s+active\\s+free`));
    assert.equal((await run("keys")).code, 1); // not linked yet
    assert.equal((await run("link", ref)).code, 0);
    assert.equal((await readFile(join(cwd, ".baas", "project"), "utf8")).trim(), ref);
    assert.match((await run("keys")).out, /anon:\s+eyJ.*\nservice_role:\s+eyJ/);
    assert.equal((await run("link", "z".repeat(20))).code, 1);
  });

  it("runs SQL and prints tables", async () => {
    const r = await run("sql", "SELECT 1 AS a, 'two' AS b UNION ALL SELECT 3, NULL");
    assert.match(r.out, /a\s+b\n1\s+two\n3\s+NULL\n\(2 rows\)/);
    assert.equal((await run("sql", "SELECT * FROM nope")).code, 1);
    await writeFile(join(cwd, "q.sql"), "CREATE TABLE public.t1 (id int); INSERT INTO public.t1 VALUES (1)");
    assert.match((await run("sql", "--file", "q.sql")).out, /CREATE\nINSERT 1/);
    assert.equal((await run("sql")).code, 1);
  });

  it("pushes migrations in order, once, and atomically", async () => {
    const dir = join(cwd, "baas", "migrations");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "002_add_col.sql"), "ALTER TABLE public.people ADD COLUMN age int;");
    await writeFile(join(dir, "001_people.sql"), "CREATE TABLE public.people (id serial PRIMARY KEY, name text);");
    assert.match((await run("db", "status")).out, /001_people\.sql\s+pending\n002_add_col\.sql\s+pending/);
    const push = await run("db", "push");
    assert.equal(push.code, 0);
    assert.deepEqual(push.out.split("\n"), ["applied 001_people.sql", "applied 002_add_col.sql"]);
    assert.match((await run("sql", "SELECT column_name FROM information_schema.columns WHERE table_name = 'people' ORDER BY ordinal_position")).out, /id\nname\nage/);
    assert.match((await run("db", "push")).out, /up to date/);

    // A failing migration rolls back entirely and is not recorded, so a fixed retry works.
    await writeFile(join(dir, "003_bad.sql"), "CREATE TABLE public.half (id int); INSERT INTO public.people (nope) VALUES (1);");
    const bad = await run("db", "push");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /003_bad\.sql failed and was rolled back/);
    assert.match((await run("sql", "SELECT to_regclass('public.half')")).out, /NULL/);
    await writeFile(join(dir, "003_bad.sql"), "CREATE TABLE public.half (id int);");
    assert.match((await run("db", "push")).out, /applied 003_bad\.sql/);

    // Editing an applied migration is refused.
    await writeFile(join(dir, "001_people.sql"), "CREATE TABLE public.people (id serial PRIMARY KEY, name text, extra int);");
    const edited = await run("db", "push");
    assert.equal(edited.code, 1);
    assert.match(edited.err, /001_people\.sql was changed after it was applied/);
    await writeFile(join(dir, "001_people.sql"), "CREATE TABLE public.people (id serial PRIMARY KEY, name text);");
    assert.equal((await run("db", "push")).code, 0);

    await writeFile(join(dir, "bad name;.sql"), "select 1");
    assert.match((await run("db", "push")).err, /unsupported migration file name/);
  });

  it("deploys, lists, and reads logs of functions", async () => {
    await writeFile(join(cwd, "hello.mjs"), "export default () => new Response('cli hello')");
    assert.match((await run("functions", "deploy", "hello", "hello.mjs", "--no-verify-jwt")).out, /Deployed hello v1/);
    assert.match((await run("functions", "list")).out, /hello\s+1\s+false/);
    const res = await t.gw(ref, "POST", "/functions/v1/hello", {});
    assert.equal(res.text, "cli hello");
    assert.match((await run("functions", "logs", "hello")).out, /200 \d+ms/);
    await writeFile(join(cwd, "broken.mjs"), "export default (");
    assert.match((await run("functions", "deploy", "broken", "broken.mjs")).err, /syntax error/);
    assert.match((await run("functions", "delete", "hello")).out, /Deleted hello/);
  });

  it("asks the AI assistant and shows proposals without running them", async () => {
    assert.match((await run("ai", "status")).out, /off/);
    assert.match((await run("ask", "how", "many", "people?")).err, /not enabled/);
    const en = await run("ai", "enable");
    assert.match(en.out, /enabled\.\nWhen you ask a question.*sent to Anthropic/);
    fake.script([query("select count(*) as n from public.people", "count people")], [text("There are 0 people.")]);
    const a = await run("ask", "how", "many", "people?");
    assert.equal(a.code, 0);
    assert.match(a.out, /^There are 0 people\./);
    assert.match(a.out, /ran \(read-only\): select count\(\*\) as n from public.people/);
    assert.deepEqual(fake.requests[0]!.messages, [{ role: "user", content: "how many people?" }]);
    fake.script([propose("DELETE FROM public.people", "Removes everyone.")], [text("Review this.")]);
    const d = await run("ask", "remove everyone");
    assert.match(d.out, /Proposed change — NOT run\. DESTRUCTIVE: deletes EVERY row \(no WHERE\)/);
    assert.match(d.out, /DELETE FROM public.people\nReview it/);
    assert.match((await run("ai", "status")).out, /on \(scripted-model\), 2\/20/);
    assert.match((await run("ai", "disable")).out, /disabled/);
    assert.equal((await run("ask")).code, 1);
  });

  it("shows usage", async () => {
    await t.gw(ref, "GET", "/rest/v1/", { key: (await t.api("GET", `/v1/projects/${ref}/api-keys`, { token: owner })).json.anon });
    const r = await run("usage");
    assert.match(r.out, /plan: free\nrequests today: \d+ \/ 50000/);
  });

  it("creates and restores backups", { skip: !PG_BIN && "pg_dump not found" }, async () => {
    const b = await run("backups", "create", "--note", "from cli");
    assert.equal(b.code, 0);
    const id = /Backup ([0-9a-f-]{36})/.exec(b.out)![1]!;
    assert.match((await run("backups", "list")).out, /from cli/);
    await run("sql", "INSERT INTO public.people (name) VALUES ('after backup')");
    assert.match((await run("backups", "restore", id)).out, /Restored/);
    assert.match((await run("sql", "SELECT count(*) AS n FROM public.people")).out, /n\n0\n/);
  });

  it("controls the project lifecycle and reports mistakes", async () => {
    assert.match((await run("projects", "pause", ref)).out, /paused/);
    assert.match((await run("projects", "resume", ref)).out, /active/);
    assert.equal((await run("projects", "pause", "nonexistent")).code, 1);
    assert.equal((await run("bogus")).code, 2);
    assert.match((await run("help")).out, /baas <command>/);
    assert.match((await run("projects", "delete", ref)).out, /deleted/);
    assert.equal((await run("logout")).code, 0);
    assert.equal((await run("projects", "list")).code, 1);
  });
});
