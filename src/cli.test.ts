import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runCli } from "./cli.js";
import { Scripted, propose, query, text } from "./ai-testkit.js";
import { BOOT, makePlatform, PG_BIN } from "./platform-testkit.js";
import { codeFor, stepAt } from "./totp.js";

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
    t = await makePlatform(ADMIN!, { ai: { llm: fake }, pipelines: { allowPrivateTargets: true, backoffBaseMs: 10 } });
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

  it("signs in as a member with email and password", async () => {
    const org = await t.api("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "M", slug: `m-${Date.now() % 100000}`, owner_email: "cli-member@example.com", owner_password: "cli-password-1" } });
    assert.equal(org.status, 201, org.text);
    assert.equal((await run("login", "--url", apiUrl, "--email", "cli-member@example.com")).code, 1, "needs a password");
    assert.equal((await run("login", "--url", apiUrl, "--email", "cli-member@example.com", "--password", "wrong-password")).code, 1);
    const r = await run("login", "--url", apiUrl, "--email", "cli-member@example.com", "--password", "cli-password-1");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Logged in/);
    assert.equal((await readFile(join(cfg, "config.json"), "utf8")).includes("cli-password-1"), false, "the password is not stored");
    const sess = (await t.api("POST", "/v1/auth/login", { body: { email: "cli-member@example.com", password: "cli-password-1" } })).json.token;
    const enr = await t.api("POST", "/v1/me/mfa/enroll", { token: sess });
    assert.equal((await t.api("POST", "/v1/me/mfa/verify", { token: sess, body: { code: codeFor(enr.json.secret, stepAt(Date.now())) } })).status, 200);
    const needCode = await run("login", "--url", apiUrl, "--email", "cli-member@example.com", "--password", "cli-password-1");
    assert.equal(needCode.code, 1);
    assert.match(needCode.err, /authenticator/);
    assert.equal((await run("login", "--url", apiUrl, "--email", "cli-member@example.com", "--password", "cli-password-1", "--code", "000000")).code, 1);
    const withCode = await run("login", "--url", apiUrl, "--email", "cli-member@example.com", "--password", "cli-password-1", "--code", codeFor(enr.json.secret, stepAt(Date.now()) + 1));
    assert.equal(withCode.code, 0, withCode.err);
    assert.equal((await run("login", "--url", apiUrl, "--token", owner)).code, 0, "switch back");
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

  it("manages pipelines: create, deliver, inspect, pause, rotate and delete", async () => {
    const got: { sig: string; raw: string }[] = [];
    let answer = 200;
    const hook = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => { got.push({ sig: String(req.headers["x-baas-signature"]), raw: Buffer.concat(chunks).toString() }); res.statusCode = answer; res.end("x"); });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/h`;
    try {
      assert.match((await run("pipelines", "list")).out, /No pipelines/);
      assert.equal((await run("pipelines", "create", "p1")).code, 1, "tables and url are required");
      assert.match((await run("pipelines", "create", "p1", "--tables", "nope", "--url", url)).err, /no such table/);
      assert.match((await run("pipelines", "create", "p1", "--tables", "people", "--url", "ftp://x/y")).err, /http/);
      assert.match((await run("pipelines", "create", "p1", "--tables", "people", "--url", url, "--events", "truncate")).err, /events/);

      const c = await run("pipelines", "create", "people-hook", "--tables", "people", "--url", url, "--events", "insert,update");
      assert.equal(c.code, 0, c.err);
      const secret = /whsec_[\w-]+/.exec(c.out)![0];
      assert.match(c.out, /shown once/);
      assert.equal((await run("pipelines", "create", "people-hook", "--tables", "people", "--url", url)).code, 1, "names are unique");
      assert.match((await run("pipelines", "list")).out, /NAME\s+STATUS[\s\S]*people-hook\s+healthy\s+people\s+IU\s+0\s+never\s+127\.0\.0\.1:/);
      assert.equal((await run("pipelines", "list")).out.includes("whsec_"), false);

      await run("sql", "INSERT INTO public.people (name) VALUES ('via cli'); DELETE FROM public.people WHERE name = 'via cli'");
      const r = await run("pipelines", "run", "people-hook");
      assert.match(r.out, /people-hook: healthy, 1 delivered/, r.err);
      const body = JSON.parse(got[0]!.raw);
      assert.deepEqual(body.events.map((e: any) => e.type), ["INSERT"], "the delete is not in --events");
      const m = /t=(\d+),v1=(\w+)/.exec(got[0]!.sig)!;
      assert.equal(m[2], (await import("node:crypto")).createHmac("sha256", secret).update(`${m[1]}.${got[0]!.raw}`).digest("hex"));

      assert.match((await run("pipelines", "show", "PEOPLE-HOOK")).out, /status:\s+healthy\ntables:\s+people\nevents:\s+INSERT, UPDATE\nrows:\s+included/);
      assert.match((await run("pipelines", "test", "people-hook")).out, /Test event delivered: 200/);
      assert.match((await run("pipelines", "deliveries", "people-hook")).out, /WHEN\s+KIND\s+RESULT[\s\S]*test\s+ok 200[\s\S]*delivery\s+ok 200\s+1/);

      answer = 500;
      const bad = await run("pipelines", "test", "people-hook");
      assert.equal(bad.code, 1);
      assert.match(bad.err, /test event failed \(500\)/);
      answer = 200;

      assert.match((await run("pipelines", "edit", "people-hook", "--no-rows", "--events", "insert")).out, /Updated people-hook/);
      assert.match((await run("pipelines", "show", "people-hook")).out, /events:\s+INSERT\nrows:\s+primary key only/);
      assert.equal((await run("pipelines", "edit", "people-hook")).code, 1);

      assert.match((await run("pipelines", "pause", "people-hook")).out, /paused/);
      assert.match((await run("pipelines", "run", "people-hook")).err, /paused/);
      assert.match((await run("pipelines", "resume", "people-hook")).out, /healthy/);

      const rot = await run("pipelines", "rotate-secret", "people-hook");
      assert.match(rot.out, /whsec_/);
      assert.notEqual(/whsec_[\w-]+/.exec(rot.out)![0], secret);

      const id = /\(([0-9a-f-]{36})\)/.exec(c.out)![1]!;
      assert.match((await run("pipelines", "show", id.slice(0, 8))).out, /name:\s+people-hook/, "an id prefix works");
      assert.match((await run("pipelines", "show", "nope")).err, /no pipeline named/);
      assert.equal((await run("pipelines", "show")).code, 1);
      assert.match((await run("pipelines", "delete", "people-hook")).out, /Deleted people-hook/);
      assert.match((await run("pipelines", "list")).out, /No pipelines/);
      assert.equal((await run("pipelines", "bogus")).code, 1);
    } finally {
      hook.close();
    }
  });

  it("lists, installs and removes Postgres extensions", async () => {
    const all = await run("extensions", "list");
    assert.equal(all.code, 0, all.err);
    assert.match(all.out, /NAME\s+VERSION\s+STATE\s+SCHEMA\s+DESCRIPTION/);
    assert.match(all.out, /pgcrypto\s+\S+\s+installed \(required\)\s+extensions/);
    assert.match(all.out, /pg_trgm\s+\S+\s+available/);
    assert.ok(all.out.indexOf("pgcrypto") < all.out.indexOf("pg_trgm"), "installed ones come first");
    assert.match((await run("extensions", "list", "--installed")).out, /pgcrypto/);
    assert.equal((await run("extensions", "list", "--installed")).out.includes("pg_trgm"), false);
    assert.match((await run("extensions", "list", "--search", "trigram")).out, /^NAME[\s\S]*pg_trgm[^\n]*$/);
    assert.match((await run("extensions", "list", "--search", "zzzz-none")).out, /No matching/);
    assert.equal((await run("extensions", "list", "--installed", "--available")).code, 1);

    const on = await run("extensions", "install", "pg_trgm", "citext");
    assert.equal(on.code, 0, on.err);
    assert.match(on.out, /Installed pg_trgm \S+ in schema extensions[\s\S]*Installed citext/);
    assert.match((await run("sql", "SELECT extensions.similarity('abc', 'abd') > 0 AS ok")).out, /ok\ntrue\n/);
    assert.equal((await run("extensions", "list", "--available")).out.includes("pg_trgm"), false, "installed ones are not listed as available");
    assert.match((await run("extensions", "remove", "pg_trgm", "citext")).out, /Removed pg_trgm\.\nRemoved citext\./);

    assert.match((await run("extensions", "remove", "pgcrypto")).err, /used by the platform/);
    assert.match((await run("extensions", "install", "no_such_ext")).err, /not available/);
    const all2 = (await run("extensions", "list")).out;
    const opOnly = /^(\S+)\s+\S+\s+needs operator/m.exec(all2);
    if (opOnly) assert.match((await run("extensions", "install", opOnly[1]!)).err, /server operator/);
    assert.equal((await run("extensions", "install")).code, 1);
    assert.equal((await run("extensions", "bogus")).code, 1);
  });

  it("filters pipelines with --where and shows deliveries live with --follow", async () => {
    const got: any[] = [];
    const hook = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => { got.push(JSON.parse(Buffer.concat(chunks).toString())); res.end("ok"); });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/h`;
    try {
      await run("sql", "CREATE TABLE public.items (id serial PRIMARY KEY, status text, qty int, region text)");
      for (const bad of ["items.status", "status:eq:paid", "items.status:like:x", "items.status:eq", "items.status:null:x", "items.status:in:"])
        assert.match((await run("pipelines", "create", "bad", "--tables", "items", "--url", url, "--where", bad)).err, /--where|cannot read/, bad);
      assert.match((await run("pipelines", "create", "bad", "--tables", "items", "--url", url, "--where", "items.nope:eq:1")).err, /no column named nope/);
      assert.match((await run("pipelines", "create", "bad", "--tables", "items", "--url", url, "--where", "other.status:eq:1")).err, /does not watch/);

      const c = await run("pipelines", "create", "paid-items", "--tables", "items", "--url", url, "--where", "items.status:eq:paid", "--where", "items.qty:gte:5", "--where", "items.region:in:eu|us");
      assert.equal(c.code, 0, c.err);
      assert.match((await run("pipelines", "show", "paid-items")).out, /only rows:\s+items: status = paid and qty >= 5 and region in \(eu, us\)/);

      await run("sql", "INSERT INTO public.items (status, qty, region) VALUES ('paid', 9, 'eu'), ('open', 9, 'eu'), ('paid', 1, 'eu'), ('paid', 7, 'asia'), ('paid', 5, 'us')");
      assert.match((await run("pipelines", "run", "paid-items")).out, /2 delivered/);
      assert.deepEqual(got.flatMap((b) => b.events).map((e) => [e.record.qty, e.record.region]), [[9, "eu"], [5, "us"]]);

      // Follow: print what is already there, then each new delivery once, until told to stop.
      const stop = new AbortController();
      const out: string[] = [];
      let tick = 0;
      const follow = runCli(["pipelines", "deliveries", "paid-items", "--follow", "--interval", "1"], {
        out: (s) => out.push(s), err: (s) => out.push(`ERR ${s}`), cwd, env: { BAAS_CONFIG_DIR: cfg }, signal: stop.signal,
        sleep: async () => {
          tick++;
          if (tick === 1) {
            await run("sql", "INSERT INTO public.items (status, qty, region) VALUES ('paid', 50, 'us')");
            await run("pipelines", "run", "paid-items");
          } else if (tick === 2) await run("pipelines", "test", "paid-items");
          else stop.abort();
        },
      });
      assert.equal(await follow, 0);
      assert.match(out[0]!, /Following deliveries for paid-items \(Ctrl-C to stop\)/);
      const lines = out.slice(1);
      assert.equal(lines.length, 3, lines.join("\n"));
      assert.match(lines[0]!, /delivery\s+ok 200\s+2 events/, "the earlier delivery");
      assert.match(lines[1]!, /delivery\s+ok 200\s+1 event\s/, "the new one, once");
      assert.match(lines[2]!, /test\s+ok 200\s+0 events/);
      assert.equal((await run("pipelines", "deliveries", "paid-items", "--follow", "--interval", "0")).code, 1);

      assert.match((await run("pipelines", "edit", "paid-items", "--where", "items.status:null")).out, /Updated/);
      assert.match((await run("pipelines", "show", "paid-items")).out, /only rows:\s+items: status is null\n/);
      assert.match((await run("pipelines", "edit", "paid-items", "--no-where")).out, /Updated/);
      assert.equal((await run("pipelines", "show", "paid-items")).out.includes("only rows"), false);
      assert.equal((await run("pipelines", "delete", "paid-items")).code, 0);
    } finally {
      hook.close();
    }
  });

  it("asks the AI assistant and shows proposals without running them", async () => {
    assert.match((await run("ai", "status")).out, /off/);
    assert.match((await run("ask", "how", "many", "people?")).err, /not enabled/);
    const en = await run("ai", "enable");
    assert.match(en.out, /enabled\.\nWhen you ask a question.*sent to Anthropic/);
    // people is a fresh table nobody was granted, so the default identity (an anonymous visitor) sees nothing, and "everyone" mode is off.
    fake.script([query("select count(*) as n from public.people", "count people")], [text("I could not read that table.")]);
    const a = await run("ask", "how", "many", "people?");
    assert.equal(a.code, 0);
    assert.match(a.out, /^\(answering as an anonymous visitor\)\nI could not read that table\./);
    assert.match(a.out, /failed \(read-only\): select count\(\*\) as n from public\.people\n\s+permission denied for table people/);
    assert.equal((await run("ask", "x", "--as", "all")).code, 1, "everyone mode is refused until allowed");
    assert.match((await run("ask", "x", "--as", "all")).err, /does not allow/);
    assert.match((await run("ai", "config", "--allow-bypass-rls", "true")).out, /allowed; .*everyone by default/);
    assert.match((await run("ai", "status")).out, /everyone mode allowed/);
    fake.script([query("select count(*) as n from public.people", "count people")], [text("There are 0 people.")]);
    const a2 = await run("ask", "how", "many", "people?");
    assert.match(a2.out, /^\(answering as everyone — row-level security ignored\)\nThere are 0 people\./);
    assert.equal((await run("ask", "x", "--as-user", "nobody@example.com")).code, 1);
    assert.equal((await run("ask", "x", "--as", "root")).code, 1);
    assert.equal((await run("ai", "config", "--allow-bypass-rls", "maybe")).code, 1);
    fake.script([propose("DELETE FROM public.people", "Removes everyone.")], [text("Review this.")]);
    const d = await run("ask", "remove everyone");
    assert.match(d.out, /Proposed change — NOT run\. DESTRUCTIVE: deletes EVERY row \(no WHERE\)/);
    assert.match(d.out, /DELETE FROM public.people\nReview it/);
    assert.match((await run("ai", "status")).out, /on \(scripted-model\), 3\/20/);
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
