import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { WebSocket } from "ws";
import { makePlatform } from "./platform-testkit.js";
import { urlFor } from "./provision.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

// Small deterministic PRNG so a failing fuzz run can be reproduced.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

type T = Awaited<ReturnType<typeof makePlatform>>;
type Proj = Awaited<ReturnType<T["project"]>>;

async function seed(t: T, owner: string, name: string, label: string) {
  const p = await t.project(owner, name);
  await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } }); // keep rate limits out of the way
  const s = await t.sql(owner, p.ref, `
    CREATE TABLE public.vault (id serial PRIMARY KEY, secret text);
    INSERT INTO public.vault (secret) VALUES ('CANARY-${label}-SECRET');
    GRANT SELECT ON public.vault TO anon, authenticated; ALTER TABLE public.vault ENABLE ROW LEVEL SECURITY;
    CREATE POLICY open ON public.vault FOR SELECT USING (true);
    CREATE FUNCTION public.whoami() RETURNS text LANGUAGE sql AS $$ SELECT 'CANARY-${label}-RPC' $$;
    GRANT EXECUTE ON FUNCTION public.whoami() TO anon, authenticated;
    CREATE POLICY files_all ON storage.objects FOR ALL TO authenticated USING (true) WITH CHECK (true)`);
  assert.equal(s.status, 200, s.text);
  await t.gw(p.ref, "POST", "/storage/v1/bucket", { key: p.service, body: { id: "files", public: true } });
  await t.gw(p.ref, "POST", "/storage/v1/object/files/secret.txt", { key: p.service, raw: `CANARY-${label}-FILE`, headers: { "content-type": "text/plain" } });
  await t.api("PUT", `/v1/projects/${p.ref}/functions/fn`, { token: owner, body: { source: `export default () => new Response("CANARY-${label}-FN")`, verify_jwt: false } });
  const user = (await t.gw(p.ref, "POST", "/auth/v1/signup", { key: p.anon, body: { email: `${label.toLowerCase()}@canary.example`, password: "secret123" } })).json;
  return { ...p, user, owner };
}

describe("hardening: tenant isolation", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: T;
  let o1: string, o2: string;
  let A: Awaited<ReturnType<typeof seed>>, B: Awaited<ReturnType<typeof seed>>;
  let gwPort: number;

  before(async () => {
    t = await makePlatform(ADMIN!);
    o1 = await t.org();
    o2 = await t.org();
    [A, B] = await Promise.all([seed(t, o1, "a", "A"), seed(t, o2, "b", "B")]);
    gwPort = (await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" })).gateway;
  });
  after(() => t?.close());

  const noLeak = (r: { status: number; text: string }, what: string) => {
    assert.ok(!/CANARY-B|b@canary/.test(r.text), `${what} leaked tenant B data: ${r.text.slice(0, 200)}`);
  };

  it("denies every data-plane service to another project's credentials", async () => {
    const aCreds = [
      { name: "A anon", key: A.anon },
      { name: "A service_role", key: A.service },
      { name: "A user JWT", key: A.anon, token: A.user.access_token },
      { name: "A service as bearer", key: B.anon, token: A.service },
    ];
    const signed = (await t.gw(A.ref, "POST", "/storage/v1/object/sign/files/secret.txt", { key: A.service, body: { expiresIn: 60 } })).json.signedURL as string;
    const requests: Array<[string, string, unknown?]> = [
      ["GET", "/rest/v1/vault"], ["GET", "/rest/v1/vault?select=*&limit=5"], ["POST", "/rest/v1/rpc/whoami", {}], ["POST", "/rest/v1/vault", { secret: "planted" }],
      ["PATCH", "/rest/v1/vault?id=gte.0", { secret: "defaced" }], ["DELETE", "/rest/v1/vault?id=gte.0"],
      ["GET", "/auth/v1/user"], ["GET", "/auth/v1/admin/users"], ["POST", "/auth/v1/token?grant_type=password", { email: "b@canary.example", password: "secret123" }],
      ["PUT", "/auth/v1/user", { password: "hijacked1" }], ["POST", "/auth/v1/logout"],
      ["GET", "/storage/v1/bucket"], ["POST", "/storage/v1/bucket", { id: "evil" }], ["GET", "/storage/v1/object/files/secret.txt"], ["GET", "/storage/v1/object/authenticated/files/secret.txt"],
      ["POST", "/storage/v1/object/list/files", { prefix: "" }], ["DELETE", "/storage/v1/object/files", { prefixes: ["secret.txt"] }], ["POST", "/storage/v1/object/files/planted.txt", null],
      ["GET", `/storage/v1${signed}`], ["POST", "/functions/v1/fn", {}],
    ];
    let checked = 0;
    for (const c of aCreds)
      for (const [method, path, body] of requests) {
        const r = await t.gw(B.ref, method, path, { key: c.key, token: (c as any).token, ...(body === null ? { raw: "x", headers: { "content-type": "text/plain" } } : body !== undefined ? { body } : {}) });
        noLeak(r, `${c.name} ${method} ${path}`);
        // The signed-URL and open function are the only routes that answer without a key; they must still be B's own scope.
        const publicRoute = path.startsWith("/storage/v1/object/sign") || path === "/storage/v1/object/files/secret.txt" && false;
        assert.ok([401, 403, 404, 400].includes(r.status) || publicRoute, `${c.name} ${method} ${path} -> ${r.status} ${r.text.slice(0, 100)}`);
        checked++;
      }
    assert.ok(checked >= 80);
    // Nothing of B changed.
    assert.deepEqual((await t.sql(o2, B.ref, "SELECT secret FROM public.vault")).json.results[0].rows, [["CANARY-B-SECRET"]]);
    assert.equal((await t.gw(B.ref, "GET", "/storage/v1/object/public/files/secret.txt", {})).text, "CANARY-B-FILE");
  });

  it("does not let a project's own privileged key see the platform or other tenants", async () => {
    for (const path of ["/rest/v1/pg_database", "/rest/v1/pg_authid", "/rest/v1/pg_catalog.pg_database", "/rest/v1/projects", "/rest/v1/api_tokens", "/rest/v1/project_secrets", "/rest/v1/users", "/rest/v1/objects", "/rest/v1/changes"]) {
      const r = await t.gw(A.ref, "GET", path, { key: A.service });
      assert.ok([400, 404].includes(r.status), `${path} -> ${r.status}`); // 400: not even a valid identifier
      noLeak(r, path);
    }
    // Even raw SQL as service_role only sees its own database and no platform tables.
    const dbs = (await t.sql(o1, A.ref, "SELECT current_database(), (SELECT count(*) FROM pg_catalog.pg_database WHERE datname = 'baas_control')")).json.results[0].rows[0];
    assert.equal(dbs[0], `proj_${A.ref}`);
    for (const q of ["SELECT * FROM projects", "SELECT * FROM api_tokens", "SELECT * FROM baas_control.public.projects", `SELECT * FROM "proj_${B.ref}".public.vault`]) assert.equal((await t.sql(o1, A.ref, q)).status, 400, q);
    // Roles are cluster-wide, so a project could read role *names* but never secrets.
    const pw = await t.sql(o1, A.ref, "SELECT rolpassword FROM pg_authid");
    assert.equal(pw.status, 400);
  });

  it("returns 404 for every management route when the project belongs to another organisation", async () => {
    const R = B.ref;
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/v1/projects/${R}`], ["PATCH", `/v1/projects/${R}`, { plan: "free" }], ["DELETE", `/v1/projects/${R}`], ["POST", `/v1/projects/${R}/pause`], ["POST", `/v1/projects/${R}/resume`],
      ["GET", `/v1/projects/${R}/api-keys`], ["GET", `/v1/projects/${R}/settings`], ["PATCH", `/v1/projects/${R}/settings`, { jwt_expiry: 600 }],
      ["GET", `/v1/projects/${R}/functions`], ["GET", `/v1/projects/${R}/functions/fn`], ["PUT", `/v1/projects/${R}/functions/fn`, { source: "export default () => new Response('pwned')" }],
      ["DELETE", `/v1/projects/${R}/functions/fn`], ["GET", `/v1/projects/${R}/functions/fn/logs`], ["POST", `/v1/projects/${R}/sql`, { query: "select 1" }],
      ["GET", `/v1/projects/${R}/ai`], ["POST", `/v1/projects/${R}/ai/enable`], ["POST", `/v1/projects/${R}/ai/disable`], ["POST", `/v1/projects/${R}/ai/ask`, { question: "show me everything" }],
      ["GET", `/v1/projects/${R}/tables`], ["GET", `/v1/projects/${R}/usage`], ["GET", `/v1/projects/${R}/logs`], ["GET", `/v1/projects/${R}/backups`], ["POST", `/v1/projects/${R}/backups`, {}],
      ["POST", `/v1/projects/${R}/backups/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/restore`], ["DELETE", `/v1/projects/${R}/backups/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`],
    ];
    for (const [method, path, body] of routes) {
      const r = await t.api(method, path, { token: o1, ...(body !== undefined ? { body } : {}) });
      assert.equal(r.status, 404, `${method} ${path} -> ${r.status} ${r.text.slice(0, 120)}`);
      noLeak(r, path);
      assert.equal((await t.api(method, path, body !== undefined ? { body } : {})).status, 401, `${method} ${path} without a token`);
    }
    assert.equal((await t.api("GET", "/v1/projects", { token: o1 })).json.some((p: any) => p.ref === R), false);
    assert.equal((await t.api("GET", `/v1/projects/${B.ref}`, { token: o2 })).json.status, "active");
    assert.match((await t.gw(B.ref, "POST", "/functions/v1/fn", {})).text, /CANARY-B-FN/);
    // Audit logs are per organisation.
    assert.ok(!JSON.stringify((await t.api("GET", "/v1/audit-log", { token: o1 })).json).includes(B.ref));
  });

  it("refuses realtime connections and subscriptions across projects", async () => {
    const tryWs = (host: string, key: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/realtime/v1/websocket?apikey=${key}`, { headers: { host } });
      ws.on("unexpected-response", (_r, res) => resolve(`http ${res.statusCode}`));
      ws.on("open", () => { resolve("open"); ws.close(); });
      ws.on("error", () => {});
    });
    assert.equal(await tryWs(`${B.ref}.localhost`, A.service), "http 401");
    assert.equal(await tryWs(`${B.ref}.localhost`, A.anon), "http 401");
    assert.equal(await tryWs(`${A.ref}.localhost`, B.service), "http 401");
    assert.equal(await tryWs(`${A.ref}.localhost`, A.service), "open");
  });

  it("handles protocol-level tricks: duplicate Host, absolute-form targets, forwarded headers", async () => {
    const raw = (lines: string[]) => new Promise<string>((resolve) => {
      const s = connect(gwPort, "127.0.0.1", () => s.write(lines.join("\r\n") + "\r\n\r\n"));
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf));
      s.setTimeout(3000, () => s.destroy());
    });
    const dup = await raw(["GET /rest/v1/vault HTTP/1.1", `Host: ${A.ref}.localhost`, `Host: ${B.ref}.localhost`, `apikey: ${A.anon}`, "Connection: close"]);
    assert.match(dup, /^HTTP\/1\.1 400/);
    const abs = await raw([`GET http://${B.ref}.localhost/rest/v1/vault HTTP/1.1`, `Host: ${A.ref}.localhost`, `apikey: ${A.anon}`, "Connection: close"]);
    assert.ok(!/CANARY-B/.test(abs), "absolute-form request line must not select another project");
    const fwd = await raw(["GET /rest/v1/vault HTTP/1.1", `Host: ${A.ref}.localhost`, `X-Forwarded-Host: ${B.ref}.localhost`, `Forwarded: host=${B.ref}.localhost`, `apikey: ${A.anon}`, "Connection: close"]);
    assert.match(fwd, /CANARY-A-SECRET/);
    assert.ok(!/CANARY-B/.test(fwd));
    for (const host of [`${A.ref}.localhost.evil.com`, `${A.ref}%2e.localhost`, `${A.ref.toUpperCase()}.LOCALHOST:1`, `${A.ref}@${B.ref}.localhost`, `${B.ref}.localhost\u0000${A.ref}.localhost`]) {
      const r = await raw(["GET /rest/v1/vault HTTP/1.1", `Host: ${host}`, `apikey: ${B.anon}`, "Connection: close"]);
      assert.ok(!/CANARY-B-SECRET/.test(r) || host.toUpperCase().startsWith(A.ref.toUpperCase()) === false, host);
    }
  });

  it("rejects oversized and pathological input without crashing", async () => {
    const big = Buffer.alloc(60 * 1024 * 1024, 97);
    assert.equal((await t.gw(A.ref, "POST", "/rest/v1/vault", { key: A.service, raw: big, headers: { "content-type": "application/json" } })).status, 413);
    const deep = "[".repeat(200_000) + "]".repeat(200_000);
    assert.ok([400, 413].includes((await t.gw(A.ref, "POST", "/rest/v1/vault", { key: A.service, raw: deep, headers: { "content-type": "application/json" } })).status));
    const manyCols = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`c${i}`, i]));
    assert.equal((await t.gw(A.ref, "POST", "/rest/v1/vault", { key: A.service, body: manyCols })).status, 400);
    const manyParams = Array.from({ length: 3000 }, (_, i) => `c${i}=eq.1`).join("&");
    assert.ok((await t.gw(A.ref, "GET", `/rest/v1/vault?${manyParams}`, { key: A.service })).status < 500);
    const hdr = await new Promise<string>((resolve) => {
      const s = connect(gwPort, "127.0.0.1", () => s.write(`GET /rest/v1/vault HTTP/1.1\r\nHost: ${A.ref}.localhost\r\nx-junk: ${"x".repeat(70_000)}\r\nConnection: close\r\n\r\n`));
      let b = "";
      s.on("data", (d) => (b += d));
      s.on("close", () => resolve(b));
      s.on("error", () => resolve(b));
      s.setTimeout(3000, () => s.destroy());
    });
    assert.ok(/^HTTP\/1\.1 431/.test(hdr) || hdr === "", `oversized header answered: ${hdr.slice(0, 40)}`);
    assert.equal((await t.gw(A.ref, "GET", "/healthz", {})).status, 200);
    assert.equal((await t.gw(A.ref, "GET", "/rest/v1/vault", { key: A.anon })).status, 200); // still serving
  });

  it("survives a seeded fuzz of the data plane with the most privileged key", async () => {
    const rand = rng(20260929);
    const pick = <X>(xs: X[]) => xs[Math.floor(rand() * xs.length)]!;
    const words = ["vault", "auth.users", "pg_catalog.pg_class", "information_schema.tables", "..%2f..%2fetc%2fpasswd", "%00", "'", '"', ";", "--", "/**/", "\\", "é", "🙂", "x".repeat(300), "select", "*", "id", "secret", `proj_${B.ref}`, "public", "storage.objects", "realtime.changes", "1e999", "-1", "NaN", "null", "true", "(", ")", ",", ".", "eq", "not", "or", "and"];
    const ops = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "not.eq", "fts", "cs", "nope", ""];
    const junk = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(words)).join(pick(["", ".", ",", "/", ":"]));
    const methods = ["GET", "GET", "GET", "POST", "PATCH", "DELETE", "HEAD", "PUT"];
    const before = (await t.sql(o1, A.ref, "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")).json.results[0].rows[0][0];
    const statuses = new Map<number, number>();
    for (let i = 0; i < 400; i++) {
      const q = new URLSearchParams();
      for (let j = 0; j < Math.floor(rand() * 4); j++) q.append(rand() < 0.3 ? pick(["select", "order", "limit", "offset", "or", "and", "on_conflict", "columns"]) : junk(), rand() < 0.6 ? `${pick(ops)}.${junk()}` : junk());
      const path = pick(["/rest/v1/", "/rest/v1/vault", `/rest/v1/${encodeURIComponent(junk())}`, "/rest/v1/rpc/whoami", `/rest/v1/rpc/${encodeURIComponent(junk())}`, `/auth/v1/${encodeURIComponent(junk())}`, `/storage/v1/object/files/${encodeURIComponent(junk())}`, `/storage/v1/${encodeURIComponent(junk())}`, `/functions/v1/${encodeURIComponent(junk())}`]);
      const body = rand() < 0.5 ? JSON.stringify(rand() < 0.5 ? { [junk()]: junk() } : [{ [junk()]: junk() }, junk()]) : junk();
      const r = await t.gw(A.ref, pick(methods), `${path}?${q}`, { key: A.service, raw: body, headers: { "content-type": "application/json", ...(rand() < 0.3 ? { prefer: junk() } : {}), ...(rand() < 0.2 ? { "accept-profile": junk() } : {}), ...(rand() < 0.2 ? { range: junk() } : {}) } });
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      assert.ok(r.status < 500 || r.status === 503, `#${i} ${path}?${q} -> ${r.status} ${r.text.slice(0, 200)}`);
      noLeak(r, `fuzz #${i}`);
      assert.ok(!/at .*\.(ts|js):\d+|node_modules|password|SELECT .* FROM/i.test(r.text.replace(/"password"/g, "")) || r.status < 400, `stack/SQL leaked at #${i}: ${r.text.slice(0, 200)}`);
    }
    const after = (await t.sql(o1, A.ref, "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")).json.results[0].rows[0][0];
    assert.equal(after, before, "fuzzing must not create or drop tables");
    assert.ok(statuses.size >= 3, `fuzz should exercise several outcomes, got ${JSON.stringify([...statuses])}`);
    assert.equal((await t.gw(B.ref, "GET", "/rest/v1/vault", { key: B.anon })).json[0].secret, "CANARY-B-SECRET");
  });

  it("survives a seeded fuzz of the management API", async () => {
    const rand = rng(77);
    const pick = <X>(xs: X[]) => xs[Math.floor(rand() * xs.length)]!;
    const values: unknown[] = [null, true, 0, -1, 1e21, "", "x".repeat(5000), "'; drop table projects;--", ["a"], { a: { b: [1] } }, "../../x", "\u0000", "🙂".repeat(50), "baas_" + "a".repeat(40)];
    // The fuzzer may legitimately delete or pause its target, so it works on a throwaway project.
    const C = await t.project(o1, "fuzz-target");
    const paths = ["/v1/organizations", "/v1/tokens", "/v1/projects", `/v1/projects/${C.ref}`, `/v1/projects/${C.ref}/sql`, `/v1/projects/${C.ref}/settings`, `/v1/projects/${C.ref}/functions/fn`, `/v1/projects/${C.ref}/backups`, `/v1/audit-log`, "/v1/me", "/v1/plans", "/v1/config"];
    for (let i = 0; i < 300; i++) {
      const body = rand() < 0.7 ? Object.fromEntries(Array.from({ length: Math.floor(rand() * 4) }, () => [pick(["name", "slug", "role", "plan", "query", "source", "verify_jwt", "jwt_expiry", "function_env", "note", "email"]), pick(values)])) : pick(values);
      const hdrs: Record<string, string> = rand() < 0.3 ? { "x-bootstrap-token": pick(["x", "", "bootstrap-token-for-tests-1234567890".slice(0, 20)]) } : {};
      if (typeof body === "string") hdrs["content-type"] = "application/json";
      const r = await t.api(pick(["GET", "POST", "PUT", "PATCH", "DELETE"]), pick(paths), { token: rand() < 0.8 ? o1 : pick(["", "nope", "Bearer x"]), headers: hdrs, ...(typeof body === "string" ? { raw: body } : { body }) });
      // 503 is the honest answer while a project the fuzzer just paused or deleted is still cached as active.
      assert.ok(r.status < 500 || r.status === 503, `#${i} -> ${r.status} ${r.text.slice(0, 200)}`);
    }
    assert.equal((await t.api("GET", `/v1/projects/${A.ref}`, { token: o1 })).status, 200, "project A survived the fuzz");
  });
});

describe("hardening: noisy neighbours", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: T;
  let o: string;
  let A: Awaited<ReturnType<typeof seed>>, B: Awaited<ReturnType<typeof seed>>;

  before(async () => {
    t = await makePlatform(ADMIN!, { queryTimeoutMs: 700 });
    o = await t.org();
    [A, B] = await Promise.all([seed(t, o, "loud", "A"), seed(t, o, "quiet", "B")]);
    await t.sql(o, A.ref, `
      CREATE FUNCTION public.slow() RETURNS int LANGUAGE sql AS $$ SELECT pg_sleep(3)::text::int $$;
      CREATE FUNCTION public.evade() RETURNS int LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('statement_timeout', '0', true); PERFORM pg_sleep(3); RETURN 1; END $$;
      GRANT EXECUTE ON FUNCTION public.slow(), public.evade() TO anon`);
  });
  after(() => t?.close());

  const p95 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;

  it("cancels runaway queries server-side, even when the query tries to lift its own timeout", async () => {
    for (const fn of ["slow", "evade"]) {
      const t0 = Date.now();
      const r = await t.gw(A.ref, "POST", `/rest/v1/rpc/${fn}`, { key: A.anon, body: {} });
      assert.equal(r.status, 408, `${fn}: ${r.text}`);
      assert.ok(Date.now() - t0 < 2500, `${fn} took ${Date.now() - t0} ms`);
    }
  });

  it("keeps a quiet project fast while its neighbour saturates its own pool", async () => {
    const baseline: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = Date.now();
      await t.gw(B.ref, "GET", "/rest/v1/vault", { key: B.anon });
      baseline.push(Date.now() - t0);
    }
    const storm = Array.from({ length: 40 }, () => t.gw(A.ref, "POST", "/rest/v1/rpc/slow", { key: A.anon, body: {} }));
    await new Promise((r) => setTimeout(r, 100)); // let the storm occupy A's pool
    const during: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = Date.now();
      const r = await t.gw(B.ref, "GET", "/rest/v1/vault", { key: B.anon });
      assert.equal(r.status, 200);
      during.push(Date.now() - t0);
    }
    const results = await Promise.all(storm);
    assert.ok(results.every((r) => [408, 503].includes(r.status)), `unexpected statuses: ${[...new Set(results.map((r) => r.status))]}`);
    assert.ok(results.some((r) => r.status === 408));
    // The quiet project must not be dragged into the noisy one's queue.
    assert.ok(p95(during) < Math.max(400, p95(baseline) * 8), `p95 during storm ${p95(during)} ms vs baseline ${p95(baseline)} ms`);
  });

  it("caps a project's database connections so it cannot starve the cluster", async () => {
    const secrets = (await t.platform.control.secretsFor(A.ref))!;
    const urlA = urlFor(ADMIN!, `proj_${A.ref}`, { user: `authenticator_${A.ref}`, password: secrets.dbPassword });
    const clients: pg.Client[] = [];
    let ok = 0;
    let refused = 0;
    await Promise.all(Array.from({ length: 60 }, async () => {
      const c = new pg.Client({ connectionString: urlA });
      c.on("error", () => {});
      try {
        await c.connect();
        clients.push(c);
        ok++;
      } catch (e) {
        if ((e as { code?: string }).code === "53300") refused++;
      }
    }));
    assert.ok(ok <= 25, `${ok} connections were allowed`);
    assert.ok(refused >= 35, `${refused} were refused`);
    // Neighbours are unaffected while A hogs its allowance.
    assert.equal((await t.gw(B.ref, "GET", "/rest/v1/vault", { key: B.anon })).status, 200);
    const sB = (await t.platform.control.secretsFor(B.ref))!;
    const cb = new pg.Client({ connectionString: urlFor(ADMIN!, `proj_${B.ref}`, { user: `authenticator_${B.ref}`, password: sB.dbPassword }) });
    cb.on("error", () => {});
    await cb.connect();
    assert.equal((await cb.query("SELECT 1 AS x")).rows[0].x, 1);
    await cb.end();
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  });

  it("bounds password hashing so a login storm in one project cannot starve another", async () => {
    await t.gw(A.ref, "POST", "/auth/v1/signup", { key: A.anon, body: { email: "storm@example.com", password: "secret123" } });
    await t.gw(B.ref, "POST", "/auth/v1/signup", { key: B.anon, body: { email: "calm@example.com", password: "secret123" } });
    const storm = Array.from({ length: 40 }, () => t.gw(A.ref, "POST", "/auth/v1/token?grant_type=password", { key: A.anon, body: { email: "storm@example.com", password: "secret123" } }));
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    const calm = await t.gw(B.ref, "POST", "/auth/v1/token?grant_type=password", { key: B.anon, body: { email: "calm@example.com", password: "secret123" } });
    const calmMs = Date.now() - t0;
    const results = await Promise.all(storm);
    assert.equal(calm.status, 200, "the quiet project can still sign users in");
    assert.ok(calmMs < 1500, `quiet project's login took ${calmMs} ms`);
    const ok = results.filter((r) => r.status === 200).length;
    const shed = results.filter((r) => r.status === 429).length;
    assert.ok(ok >= 1 && shed >= 1 && ok + shed === 40, `ok=${ok} shed=${shed}`);
  });

  it("limits function concurrency across the whole host", async () => {
    const p = await t.project(o, "fn-flood");
    await t.api("PUT", `/v1/projects/${p.ref}/functions/spin`, { token: o, body: { source: "export default async () => { await new Promise(r => setTimeout(r, 800)); return new Response('ok'); }", verify_jwt: false } });
    const rs = await Promise.all(Array.from({ length: 20 }, () => t.gw(p.ref, "POST", "/functions/v1/spin", {})));
    const ok = rs.filter((r) => r.status === 200).length;
    const shed = rs.filter((r) => r.status === 429).length;
    assert.ok(ok >= 1 && ok <= 4, `${ok} ran at once`);
    assert.equal(ok + shed, 20);
  });
});
