import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { FunctionService } from "./functions.js";
import { makeHarness, type Harness, type TestProject } from "./testkit.js";
import { checkSyntax } from "./sandbox.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

const ECHO = `export default async (req) => {
  const u = new URL(req.url);
  return new Response(JSON.stringify({ method: req.method, path: u.pathname, q: u.search, body: await req.text(), auth: req.headers.get("authorization") }),
    { status: 201, headers: { "content-type": "application/json", "x-custom": "yes", "set-cookie": "a=b" } });
};`;

describe("sandbox", () => {
  it("parse-checks source", async () => {
    assert.equal(await checkSyntax("export default () => new Response('ok')"), null);
    assert.match((await checkSyntax("export default (")) ?? "", /Error/);
  });
});

describe("edge functions", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let h: Harness;
  let a: TestProject;
  let b: TestProject;
  let svc: FunctionService;
  let tight: FunctionService;

  const deploy = (p: TestProject, name: string, source: string, verify = true) => h.control.deployFunction(h.owner, p.ref, name, source, verify);
  const invoke = (p: TestProject, name: string, o: Parameters<Harness["call"]>[3] & { method?: string; path?: string } = {}) =>
    h.call(p, o.method ?? "POST", `/functions/v1/${name}${o.path ?? ""}`, { key: p.anon, ...o });

  before(async () => {
    h = await makeHarness(ADMIN!, (_pm, control) => {
      svc = new FunctionService(control, { publicUrl: (ref) => `http://${ref}.localhost:8081`, timeoutMs: 1500, perProject: 1 });
      return { services: { functions: svc } };
    });
    [a, b] = await Promise.all([h.project(), h.project()]);
  });
  after(() => h?.close());

  it("runs a deployed function with the request and returns its response", async () => {
    await deploy(a, "echo", ECHO);
    const u = await h.call(a, "POST", "/auth/v1/signup", { key: a.anon, body: { email: "f@example.com", password: "secret123" } });
    const r = await invoke(a, "echo", { path: "/sub/path?x=1", raw: "hello body", token: u.json.access_token, headers: { "content-type": "text/plain" } });
    assert.equal(r.status, 201);
    assert.equal(r.json.method, "POST");
    assert.equal(r.json.path, "/functions/v1/echo/sub/path");
    assert.equal(r.json.q, "?x=1");
    assert.equal(r.json.body, "hello body");
    assert.equal(r.json.auth, `Bearer ${u.json.access_token}`);
    assert.equal(r.headers["x-custom"], "yes");
    assert.equal(r.headers["set-cookie"], undefined); // cookies on the project origin are not allowed
  });

  it("gives the function project env and configured variables, and nothing from the host", async () => {
    await h.control.updateSettings(h.owner, a.ref, { function_env: { MY_FLAG: "on" } });
    await deploy(a, "env", `export default () => new Response(JSON.stringify(process.env));`);
    process.env.SECRET_HOST_VAR = "leak-me";
    const env = (await invoke(a, "env")).json;
    delete process.env.SECRET_HOST_VAR;
    assert.deepEqual(Object.keys(env).sort(), ["MY_FLAG", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
    assert.equal(env.SUPABASE_URL, `http://${a.ref}.localhost:8081`);
    assert.equal(env.SUPABASE_ANON_KEY, a.anon);
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, a.service);
  });

  it("denies filesystem, subprocess and worker access", async () => {
    await deploy(a, "escape", `
      import fs from "node:fs"; import cp from "node:child_process"; import { Worker } from "node:worker_threads";
      const attempt = (f) => { try { f(); return "ALLOWED"; } catch (e) { return e.code ?? e.message; } };
      export default async () => new Response(JSON.stringify({
        read: attempt(() => fs.readFileSync("/etc/passwd")),
        readHome: attempt(() => fs.readdirSync("/home")),
        write: attempt(() => fs.writeFileSync("/tmp/pwned", "x")),
        spawn: attempt(() => cp.execSync("id")),
        worker: attempt(() => new Worker("1", { eval: true })),
      }));`);
    const r = (await invoke(a, "escape")).json;
    assert.deepEqual(r, { read: "ERR_ACCESS_DENIED", readHome: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", worker: "ERR_ACCESS_DENIED" });
  });

  it("cannot read another project's function source", async () => {
    await deploy(b, "secret-b", `export default () => new Response("b's code")`);
    await deploy(a, "peek", `
      import fs from "node:fs";
      export default () => { let out = []; for (const p of process.argv.slice(1)) out.push(p); return new Response(JSON.stringify(out)); };`);
    const paths: string[] = (await invoke(a, "peek")).json;
    assert.ok(paths.every((p) => !p.includes(b.ref)));
  });

  it("kills functions that run too long", async () => {
    await deploy(a, "spin", `export default () => { while (true) {} };`);
    const t0 = Date.now();
    const r = await invoke(a, "spin");
    assert.equal(r.status, 504);
    assert.ok(Date.now() - t0 < 4000);
  });

  it("contains crashes and memory blow-ups", async () => {
    await deploy(a, "boom", `export default () => { throw new Error("kaboom"); };`);
    const boom = await invoke(a, "boom");
    assert.equal(boom.status, 500);
    assert.ok(!boom.text.includes("kaboom")); // internals are not leaked to callers
    await deploy(a, "hog", `export default () => { const a = []; for (;;) a.push(new Array(1e6).fill("x")); };`);
    // Either way the runaway is stopped and contained: an out-of-memory crash is a 500, and on a slow machine the time limit can win first (504).
    assert.ok([500, 504].includes((await invoke(a, "hog")).status));
    await deploy(a, "notresp", `export default () => "a string";`);
    assert.equal((await invoke(a, "notresp")).status, 500);
  });

  it("limits concurrent invocations per project", async () => {
    await deploy(a, "slow", `export default async () => { await new Promise((r) => setTimeout(r, 700)); return new Response("done"); };`);
    const [x, y] = await Promise.all([invoke(a, "slow"), invoke(a, "slow")]);
    assert.deepEqual([x.status, y.status].sort(), [200, 429]);
    assert.equal((await invoke(a, "slow")).status, 200);
  });

  it("enforces verify_jwt", async () => {
    await deploy(a, "guarded", `export default () => new Response("ok")`, true);
    await deploy(a, "open", `export default () => new Response("ok")`, false);
    assert.equal((await h.call(a, "POST", "/functions/v1/guarded", {})).status, 401);
    assert.equal((await invoke(a, "guarded")).status, 200);
    assert.equal((await h.call(a, "POST", "/functions/v1/guarded", { key: b.anon })).status, 401); // other project's key
    assert.equal((await h.call(a, "POST", "/functions/v1/open", {})).status, 200);
    assert.equal((await h.call(a, "POST", "/functions/v1/open", { key: "garbage" })).status, 401);
  });

  it("isolates functions per project and 404s unknown ones", async () => {
    assert.equal((await invoke(b, "echo")).status, 404);
    assert.equal((await invoke(a, "does-not-exist")).status, 404);
    assert.equal((await invoke(a, "Bad_Name!")).status, 404);
  });

  it("validates deploys and enforces roles", async () => {
    await assert.rejects(deploy(a, "bad", "export default ("), /syntax error/);
    await assert.rejects(deploy(a, "Bad Name", ECHO), /function name/);
    await assert.rejects(deploy(a, "huge", "//" + "x".repeat(300 * 1024)), /256 KB/);
    const dev = (await h.control.authenticate(await (async () => {
      const { ownerToken } = await h.control.createOrg("Dev", `dev-${Math.random().toString(36).slice(2, 8)}`);
      return ownerToken;
    })()))!;
    await assert.rejects(h.control.deployFunction({ ...dev, role: "developer" }, a.ref, "x", ECHO), /requires admin/);
    await assert.rejects(h.control.deployFunction(dev, a.ref, "x", ECHO), /project not found/); // another org's project
  });

  it("versions redeploys, lists, and deletes", async () => {
    await deploy(a, "ver", `export default () => new Response("v1")`);
    assert.equal((await invoke(a, "ver")).text, "v1");
    const v2 = await deploy(a, "ver", `export default () => new Response("v2")`);
    assert.equal(v2.version, 2);
    assert.equal((await invoke(a, "ver")).text, "v2");
    assert.ok((await h.control.listFunctions(h.owner, a.ref)).some((f: any) => f.name === "ver" && f.version === 2));
    await h.control.deleteFunction(h.owner, a.ref, "ver");
    assert.equal((await invoke(a, "ver")).status, 404);
  });

  it("records invocation logs", async () => {
    const logs = svc.logsFor(a.ref, "boom");
    assert.ok(logs.length >= 1 && logs[0]!.status === 500 && /kaboom/.test(logs[0]!.note ?? ""));
    assert.deepEqual(svc.logsFor(b.ref), []);
  });

  it("stops a paused project's functions", async () => {
    const p = await h.project();
    await deploy(p, "f", `export default () => new Response("ok")`);
    assert.equal((await invoke(p, "f")).status, 200);
    await h.control.pauseProject(h.owner, p.ref);
    assert.equal((await invoke(p, "f")).status, 503);
  });
});
