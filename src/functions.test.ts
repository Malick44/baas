import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import zlib from "node:zlib";
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
      // The in-process egress guard is off here so this suite tests the permission model and the service on their own; the next suite tests the guard.
      svc = new FunctionService(control, { publicUrl: (ref) => `http://${ref}.localhost:8081`, timeoutMs: 1500, perProject: 1, egress: "off" });
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

describe("edge functions: what they may reach", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let h: Harness;
  let a: TestProject;
  let guarded: FunctionService;
  let target: http.Server;
  let other: http.Server;
  let targetHost: string;
  let otherHost: string;
  const seen: { method: string; url: string; body: string; headers: http.IncomingHttpHeaders }[] = [];

  const deploy = (p: TestProject, name: string, source: string) => h.control.deployFunction(h.owner, p.ref, name, source, false);
  const run = async (name: string, source: string, p = a) => {
    await deploy(p, name, source);
    return h.call(p, "POST", `/functions/v1/${name}`, { key: p.anon });
  };
  /** A function that tries something and reports what happened instead of crashing. */
  const attempt = (body: string) => `export default async () => { const out = {}; try { out.value = await (async () => { ${body} })(); } catch (e) { out.error = String(e && e.message || e); } return Response.json(out); };`;

  before(async () => {
    const mk = (fn: http.RequestListener) => new Promise<http.Server>((r) => { const s = http.createServer(fn); s.listen(0, "127.0.0.1", () => r(s)); });
    other = await mk((_req, res) => res.end("other"));
    otherHost = `127.0.0.1:${(other.address() as AddressInfo).port}`;
    target = await mk((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, body: Buffer.concat(chunks).toString(), headers: req.headers });
        if (req.url === "/redirect-inside") { res.statusCode = 302; res.setHeader("location", "/landed"); return res.end(); }
        if (req.url === "/redirect-out") { res.statusCode = 302; res.setHeader("location", `http://${otherHost}/`); return res.end(); }
        if (req.url === "/gzip") { res.setHeader("content-encoding", "gzip"); return res.end(zlib.gzipSync("zipped hello")); }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ hello: req.url, got: Buffer.concat(chunks).toString() }));
      });
    });
    targetHost = `127.0.0.1:${(target.address() as AddressInfo).port}`;
    h = await makeHarness(ADMIN!, (_pm, control) => {
      const publicUrl = (ref: string) => `http://${ref}.localhost:8081`;
      guarded = new FunctionService(control, { publicUrl, timeoutMs: 4000, perProject: 8, egressAllow: [targetHost] });
      return { services: { functions: guarded } };
    });
    a = await h.project();
  });
  after(async () => {
    target?.close();
    other?.close();
    await h?.close();
  });

  it("refuses private, loopback and link-local destinations by default, including by name and by IPv6 and mapped forms", async () => {
    for (const url of [`http://${otherHost}/`, "http://127.0.0.1:1/", "http://localhost:1/", "http://[::1]:1/", "http://[::ffff:127.0.0.1]:1/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/", "http://0.0.0.0:1/", "http://2130706433:1/"]) {
      const r = await run("blocked", attempt(`return (await fetch(${JSON.stringify(url)})).status`));
      assert.match(r.json.error ?? "", /private or local network|could not resolve|only http/, `${url}: ${JSON.stringify(r.json)}`);
    }
    assert.equal((await run("blocked", attempt(`return (await fetch("file:///etc/passwd")).status`))).json.error?.includes("only http"), true);
    assert.equal((await run("blocked", attempt(`return (await fetch("ftp://example.com/")).status`))).json.error?.includes("only http"), true);
  });

  it("allows what the operator listed, plus the project's own address, and still behaves like fetch", async () => {
    const r = await run("ok", attempt(`
      const a = await (await fetch("http://${targetHost}/hi?x=1")).json();
      const b = await (await fetch("http://${targetHost}/post", { method: "POST", body: "payload", headers: { "content-type": "text/plain", "x-mine": "1" } })).json();
      const c = await (await fetch("http://${targetHost}/redirect-inside")).json();
      const d = await (await fetch("http://${targetHost}/gzip")).text();
      const e = await fetch("http://${targetHost}/redirect-inside", { redirect: "manual" });
      return { a, b, c, d, manual: [e.status, e.headers.get("location")] };`));
    assert.equal(r.json.error, undefined, r.text);
    assert.equal(r.json.value.a.hello, "/hi?x=1");
    assert.deepEqual(r.json.value.b, { hello: "/post", got: "payload" });
    assert.equal(r.json.value.c.hello, "/landed", "redirects inside an allowed host are followed");
    assert.equal(r.json.value.d, "zipped hello", "compressed responses are decoded");
    assert.deepEqual(r.json.value.manual, [302, "/landed"]);
    const post = seen.find((s) => s.url === "/post")!;
    assert.equal(post.method, "POST");
    assert.equal(post.headers["x-mine"], "1");
    // The project's own URL (what SUPABASE_URL points at) is always reachable, so functions can call their own API.
    const own = await run("own", attempt(`try { await fetch(process.env.SUPABASE_URL + "/rest/v1/"); return "reached"; } catch (e) { return String(e.cause?.code || e.message); }`));
    assert.doesNotMatch(own.json.value ?? own.json.error, /private or local/);
  });

  it("re-checks every redirect, so an allowed host cannot send a function to a forbidden one", async () => {
    const r = await run("hop", attempt(`return (await fetch("http://${targetHost}/redirect-out")).status`));
    assert.match(r.json.error ?? "", /private or local network/, r.text);
    assert.equal(seen.some((s) => s.url === "/redirect-out"), true);
  });

  it("cannot open sockets, spawn, signal the server, or reach other internals through imports", async () => {
    for (const mod of ["node:net", "net", "node:http", "node:https", "node:http2", "node:tls", "node:dns", "node:dns/promises", "node:dgram", "node:child_process", "node:cluster",
      "node:worker_threads", "node:module", "node:inspector", "node:os", "node:fs", "node:vm", "node:v8", "node:repl"]) {
      const r = await run("imp", attempt(`await import(${JSON.stringify(mod)}); return "imported"`));
      assert.match(r.json.error ?? "", /not available in functions|Access to this API has been restricted|ERR_ACCESS_DENIED/, `${mod}: ${r.text}`);
    }
    // The ways around a plain import.
    const via = await run("via", attempt(`return typeof process.getBuiltinModule`));
    assert.equal(via.json.value, "undefined");
    const data = await run("data", attempt(`await import("data:text/javascript,import 'node:net'; export default 1"); return "imported"`));
    assert.match(data.json.error ?? "", /not available in functions/, data.text);
    const bind = await run("bind", attempt(`return process.binding("tcp_wrap") && "reached"`));
    assert.ok(bind.json.error, "process.binding stays blocked");
    for (const g of ["WebSocket", "EventSource", "XMLHttpRequest"]) assert.equal((await run("g", attempt(`return typeof globalThis.${g}`))).json.value, "undefined", g);
    // Ordinary code is unaffected.
    const fine = await run("fine", attempt(`
      const { createHash } = await import("node:crypto"); const { Buffer } = await import("node:buffer"); const u = await import("node:util"); const z = await import("node:zlib");
      return [createHash("sha256").update("x").digest("hex").slice(0, 8), Buffer.from("hi").toString("base64"), typeof u.inspect, z.gzipSync("a").length > 0, crypto.randomUUID().length];`));
    assert.deepEqual(fine.json.value, ["2d711642", "aGk=", "function", true, 36], fine.text);
  });

  it("cannot signal the server process", async () => {
    const r = await run("kill", attempt(`process.kill(process.ppid, "SIGKILL"); return "sent"`));
    assert.match(r.json.error ?? "", /process\.kill is not available/, r.text);
    // The server (this process) is still here.
    assert.equal((await h.call(a, "POST", "/functions/v1/kill", { key: a.anon })).status, 200);
  });

  it('"open" mode lifts the address restriction for operators who want it, but keeps the module and signal protections', async () => {
    const h2 = await makeHarness(ADMIN!, (_pm, control) => ({ services: { functions: new FunctionService(control, { publicUrl: (ref) => `http://${ref}.localhost:8081`, timeoutMs: 4000, egress: "open" }) } }));
    try {
      const p2 = await h2.project();
      const call = async (name: string, source: string) => {
        await h2.control.deployFunction(h2.owner, p2.ref, name, source, false);
        return h2.call(p2, "POST", `/functions/v1/${name}`, { key: p2.anon });
      };
      assert.equal((await call("openreach", attempt(`return (await fetch("http://${otherHost}/")).status`))).json.value, 200);
      assert.match((await call("openimp", attempt(`await import("node:net"); return "imported"`))).json.error ?? "", /not available in functions/);
      assert.match((await call("openkill", attempt(`process.kill(process.ppid, 0); return "sent"`))).json.error ?? "", /process\.kill/);
    } finally {
      await h2.close();
    }
  });
});
