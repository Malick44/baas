import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { isPrivateAddress, sign } from "./pipelines.js";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("addresses pipelines may not reach", () => {
  it("blocks private, loopback, link-local and mapped addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "not-an-ip"])
      assert.equal(isPrivateAddress(a), true, a);
    for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(a), false, a);
  });
});

describe("pipelines and extensions", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let strict: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string, admin_: string, dev: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  let server: http.Server;
  let answer = 200;
  let hits: { headers: http.IncomingHttpHeaders; body: any; raw: string }[] = [];
  let url: string;
  const base = () => `/v1/projects/${p.ref}/pipelines`;
  const create = (over: Record<string, unknown> = {}, token = owner) => t.api("POST", base(), { token, body: { name: `pl-${Math.random().toString(36).slice(2, 7)}`, tables: ["orders"], url, ...over } });
  const run = (id: string) => t.api("POST", `${base()}/${id}/run`, { token: owner });

  before(async () => {
    t = await makePlatform(ADMIN!, { pipelines: { allowPrivateTargets: true, backoffBaseMs: 10, maxFailures: 3 } });
    strict = await makePlatform(ADMIN!);
    owner = await t.org();
    admin_ = await t.token(owner, "admin");
    dev = await t.token(owner, "developer");
    p = await t.project(owner, "main");
    await t.sql(owner, p.ref, "create table public.orders (id serial primary key, item text, qty int); create table public.audit_noise (id serial primary key, x text)");
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        hits.push({ headers: req.headers, body: JSON.parse(raw), raw });
        res.statusCode = answer;
        res.end(answer === 200 ? "ok" : "nope");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  after(async () => {
    server?.close();
    await t?.close();
    await strict?.close();
  });

  it("validates input and is for admins only", async () => {
    assert.equal((await create({}, dev)).status, 403);
    assert.equal((await create({ url: "ftp://example.com/x" })).status, 400);
    assert.equal((await create({ url: "http://user:pw@example.com/x" })).status, 400);
    assert.equal((await create({ tables: ["nope"] })).status, 400);
    assert.equal((await create({ tables: [] })).status, 400);
    assert.equal((await create({ tables: ["orders; drop table orders"] })).status, 400);
    assert.equal((await create({ events: ["TRUNCATE"] })).status, 400);
    assert.equal((await create({ name: "" })).status, 400);
    assert.equal((await t.api("GET", base(), { token: dev })).status, 403);
  });

  it("creates a pipeline, shows the secret once, and delivers only new changes, in order, signed", async () => {
    await t.sql(owner, p.ref, "insert into public.orders (item, qty) values ('before', 1)");
    const c = await create({ name: "orders-hook" }, admin_);
    assert.equal(c.status, 201, c.text);
    assert.match(c.json.secret, /^whsec_/);
    assert.equal(c.json.status, "healthy");
    assert.equal(JSON.stringify((await t.api("GET", base(), { token: owner })).json).includes("whsec_"), false, "the secret is not listed again");
    assert.equal(JSON.stringify((await t.api("GET", base(), { token: owner })).json).includes("secret_enc"), false);

    hits = [];
    await t.sql(owner, p.ref, "insert into public.orders (item, qty) values ('a', 2), ('b', 3); update public.orders set qty = 9 where item = 'a'; delete from public.orders where item = 'b'; insert into public.audit_noise (x) values ('ignored')");
    const r = await run(c.json.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(hits.length, 1);
    const hit = hits[0]!;
    assert.equal(hit.body.type, "changes");
    assert.equal(hit.body.project, p.ref);
    assert.deepEqual(hit.body.events.map((e: any) => `${e.type}:${e.table}`), ["INSERT:orders", "INSERT:orders", "UPDATE:orders", "DELETE:orders"]);
    assert.ok(!hit.body.events.some((e: any) => e.item === "before" || e.record?.item === "before"), "existing rows are not replayed");
    assert.equal(hit.body.events[2].record.qty, 9);
    assert.equal(hit.body.events[3].record, null, "a delete carries only the key");
    assert.deepEqual(Object.keys(hit.body.events[3].pk), ["id"]);
    const ids = hit.body.events.map((e: any) => BigInt(e.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : 1)));

    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(hit.headers["x-baas-signature"]))!;
    assert.ok(sig);
    assert.equal(hit.headers["x-baas-signature"], sign(c.json.secret, Number(sig[1]), hit.raw), "signature verifies with the secret shown at creation");
    assert.equal(hit.headers["x-baas-event"], "changes");

    assert.equal(r.json.delivered, 4);
    hits = [];
    await run(c.json.id);
    assert.equal(hits.length, 0, "nothing is sent twice once it succeeded");
    const log = (await t.api("GET", `${base()}/${c.json.id}/deliveries`, { token: owner })).json;
    assert.equal(log[0].ok, true);
    assert.equal(log[0].events, 4);
    assert.equal((await t.api("DELETE", `${base()}/${c.json.id}`, { token: owner })).status, 204);
  });

  it("filters by event and can leave rows out", async () => {
    const c = await create({ events: ["DELETE"], include_rows: false });
    hits = [];
    await t.sql(owner, p.ref, "insert into public.orders (item) values ('x'); update public.orders set qty = 1 where item = 'x'; delete from public.orders where item = 'x'");
    await run(c.json.id);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0]!.body.events.map((e: any) => e.type), ["DELETE"]);
    const c2 = await create({ include_rows: false });
    await t.sql(owner, p.ref, "insert into public.orders (item) values ('y')");
    hits = [];
    await run(c2.json.id);
    assert.equal(hits[0]!.body.events[0].record, null);
    for (const id of [c.json.id, c2.json.id]) await t.api("DELETE", `${base()}/${id}`, { token: owner });
  });

  it("keeps an undelivered change and retries it, then pauses itself after repeated failures", async () => {
    const c = await create();
    answer = 500;
    hits = [];
    await t.sql(owner, p.ref, "insert into public.orders (item) values ('retry-me')");
    let r = await run(c.json.id);
    assert.equal(r.json.status, "failing");
    assert.equal(r.json.consecutive_failures, 1);
    assert.match(r.json.last_error, /500/);
    assert.equal(r.json.delivered, 0);

    answer = 200;
    hits = [];
    r = await run(c.json.id);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.body.events[0].record.item, "retry-me", "the same change is sent again");
    assert.equal(r.json.status, "healthy");
    assert.equal(r.json.consecutive_failures, 0);

    answer = 500;
    for (let i = 0; i < 3; i++) {
      await t.sql(owner, p.ref, `insert into public.orders (item) values ('f${i}')`);
      await run(c.json.id).catch(() => {});
    }
    const list = (await t.api("GET", base(), { token: owner })).json.find((x: any) => x.id === c.json.id);
    assert.equal(list.enabled, false);
    assert.equal(list.status, "paused");
    assert.match(list.disabled_reason, /Paused after 3 failed deliveries/);
    assert.equal((await run(c.json.id)).status, 409);

    answer = 200;
    hits = [];
    const back = await t.api("PATCH", `${base()}/${c.json.id}`, { token: owner, body: { enabled: true } });
    assert.equal(back.json.status, "healthy");
    assert.equal(back.json.disabled_reason, null);
    await run(c.json.id);
    assert.ok(hits.flatMap((h) => h.body.events).length >= 3, "what was missed while paused is delivered");
    await t.api("DELETE", `${base()}/${c.json.id}`, { token: owner });
  });

  it("sends only the rows that match a filter, always sends deletes, and validates filters against the real columns", async () => {
    await t.sql(owner, p.ref, "create table public.sales (id serial primary key, status text, total numeric, region text, note text)");
    assert.equal((await create({ tables: ["sales"], filters: { orders: [{ column: "item", op: "eq", value: "x" }] } })).status, 400, "a filter for an unwatched table");
    assert.match((await create({ tables: ["sales"], filters: { sales: [{ column: "nope", op: "eq", value: 1 }] } })).json.error, /no column named nope/);
    assert.match((await create({ tables: ["sales"], filters: { sales: [{ column: "total", op: "gt", value: "abc" }] } })).json.error, /not valid/);
    for (const bad of [{ sales: [{ column: "status", op: "like", value: "x" }] }, { sales: [{ column: "status", op: "eq" }] }, { sales: [{ column: "status", op: "in", value: [] }] },
      { sales: [{ column: "status; drop", op: "eq", value: 1 }] }, { sales: "status=paid" }, [], { sales: Array(11).fill({ column: "status", op: "null" }) }, { sales: [{ column: "status", op: "eq", value: { a: 1 } }] }])
      assert.equal((await create({ tables: ["sales"], filters: bad })).status, 400, JSON.stringify(bad));

    const c = await create({ tables: ["sales"], filters: { sales: [{ column: "status", op: "eq", value: "paid" }, { column: "total", op: "gte", value: 100 }, { column: "region", op: "in", value: ["eu", "us"] }, { column: "note", op: "null" }] } });
    assert.equal(c.status, 201, c.text);
    assert.equal(c.json.filters.sales.length, 4);
    hits = [];
    await t.sql(owner, p.ref, `insert into public.sales (status, total, region, note) values
      ('paid', 150, 'eu', null), ('paid', 50, 'eu', null), ('open', 500, 'eu', null), ('paid', 200, 'asia', null), ('paid', 300, 'us', 'has a note'), ('paid', 100, 'us', null)`);
    await run(c.json.id);
    const sent = hits.flatMap((h) => h.body.events);
    assert.deepEqual(sent.map((e: any) => [e.record.status, Number(e.record.total), e.record.region]), [["paid", 150, "eu"], ["paid", 100, "us"]], "only rows meeting every condition");

    // An update is judged on the row as it is now: it starts matching, or stops.
    hits = [];
    await t.sql(owner, p.ref, "update public.sales set total = 120 where total = 50; update public.sales set status = 'refunded' where total = 150");
    await run(c.json.id);
    assert.deepEqual(hits.flatMap((h) => h.body.events).map((e: any) => `${e.type}:${Number(e.record.total)}`), ["UPDATE:120"], "the row that stopped matching is not sent");

    // Deletes carry no row, so they cannot be checked and are always sent.
    hits = [];
    await t.sql(owner, p.ref, "delete from public.sales where status = 'open'");
    await run(c.json.id);
    assert.deepEqual(hits.flatMap((h) => h.body.events).map((e: any) => e.type), ["DELETE"]);

    // Filters work without row data too, and can be changed or cleared.
    const off = await t.api("PATCH", `${base()}/${c.json.id}`, { token: owner, body: { include_rows: false } });
    assert.equal(off.json.filters.sales.length, 4, "unrelated edits keep the filters");
    hits = [];
    await t.sql(owner, p.ref, "insert into public.sales (status, total, region) values ('paid', 999, 'eu'), ('open', 999, 'eu')");
    await run(c.json.id);
    const noRows = hits.flatMap((h) => h.body.events);
    assert.equal(noRows.length, 1);
    assert.equal(noRows[0].record, null);
    assert.equal((await t.api("PATCH", `${base()}/${c.json.id}`, { token: owner, body: { filters: { sales: [{ column: "nope", op: "null" }] } } })).status, 400);
    const cleared = await t.api("PATCH", `${base()}/${c.json.id}`, { token: owner, body: { filters: {}, include_rows: true } });
    assert.deepEqual(cleared.json.filters, {});
    hits = [];
    await t.sql(owner, p.ref, "insert into public.sales (status, total, region) values ('open', 1, 'asia')");
    await run(c.json.id);
    assert.equal(hits.flatMap((h) => h.body.events).length, 1, "no filter sends everything again");

    // Narrowing the table list drops filters for tables that are no longer watched.
    const two = await create({ tables: ["sales", "orders"], filters: { sales: [{ column: "status", op: "null" }] } });
    const narrowed = await t.api("PATCH", `${base()}/${two.json.id}`, { token: owner, body: { tables: ["orders"] } });
    assert.deepEqual(narrowed.json.filters, {});
    for (const id of [c.json.id, two.json.id]) await t.api("DELETE", `${base()}/${id}`, { token: owner });
    await t.sql(owner, p.ref, "drop table public.sales");
  });

  it("a filter that stops working makes the pipeline fail instead of dropping rows", async () => {
    await t.sql(owner, p.ref, "create table public.gadgets (id serial primary key, weight int)");
    const c = await create({ tables: ["gadgets"], filters: { gadgets: [{ column: "weight", op: "gt", value: 5 }] } });
    assert.equal(c.status, 201, c.text);
    await t.sql(owner, p.ref, "insert into public.gadgets (weight) values (10)");
    await t.sql(owner, p.ref, "alter table public.gadgets alter column weight type boolean using (weight > 0)");
    hits = [];
    const r = await run(c.json.id);
    assert.equal(r.json.status, "failing");
    assert.match(r.json.last_error, /boolean|cast/);
    assert.equal(hits.length, 0);
    await t.api("DELETE", `${base()}/${c.json.id}`, { token: owner });
    await t.sql(owner, p.ref, "drop table public.gadgets");
  });

  it("sends a test event without touching the cursor, and rotates the secret", async () => {
    const c = await create();
    hits = [];
    let r = await t.api("POST", `${base()}/${c.json.id}/test`, { token: owner });
    assert.equal(r.json.ok, true);
    assert.equal(hits[0]!.body.type, "test");
    assert.equal(hits[0]!.headers["x-baas-event"], "test");
    const list = (await t.api("GET", base(), { token: owner })).json.find((x: any) => x.id === c.json.id);
    assert.equal(list.delivered, 0);

    const rot = await t.api("POST", `${base()}/${c.json.id}/rotate-secret`, { token: owner });
    assert.match(rot.json.secret, /^whsec_/);
    assert.notEqual(rot.json.secret, c.json.secret);
    hits = [];
    r = await t.api("POST", `${base()}/${c.json.id}/test`, { token: owner });
    const sig = /t=(\d+),v1=(\w+)/.exec(String(hits[0]!.headers["x-baas-signature"]))!;
    assert.equal(hits[0]!.headers["x-baas-signature"], sign(rot.json.secret, Number(sig[1]), hits[0]!.raw));
    assert.notEqual(hits[0]!.headers["x-baas-signature"], sign(c.json.secret, Number(sig[1]), hits[0]!.raw), "the old secret no longer signs");
    answer = 503;
    r = await t.api("POST", `${base()}/${c.json.id}/test`, { token: owner });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.status, 503);
    answer = 200;
    await t.api("DELETE", `${base()}/${c.json.id}`, { token: owner });
  });

  it("background pass delivers without being asked", async () => {
    const c = await create();
    hits = [];
    await t.sql(owner, p.ref, "insert into public.orders (item) values ('tick')");
    await t.platform.pipelines.tick();
    assert.equal(hits.length, 1);
    await t.api("DELETE", `${base()}/${c.json.id}`, { token: owner });
  });

  it("refuses private destinations by default, isolates projects, and 404s for others", async () => {
    const o2 = await strict.org();
    const p2 = await strict.project(o2, "strict");
    await strict.sql(o2, p2.ref, "create table public.orders (id serial primary key)");
    for (const u of ["http://127.0.0.1:9/x", "http://localhost/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/x", "http://10.0.0.5/x"]) {
      const r = await strict.api("POST", `/v1/projects/${p2.ref}/pipelines`, { token: o2, body: { name: "x", tables: ["orders"], url: u } });
      assert.equal(r.status, 400, u);
      assert.match(r.json.error, /private|local|resolve/i, u);
    }
    const other = await t.org();
    assert.equal((await t.api("GET", base(), { token: other })).status, 404);
  });

  it("the change log is not pruned while a pipeline still needs it", async () => {
    const c = await create();
    await t.sql(owner, p.ref, "insert into public.orders (item) values ('kept')");
    // Age the log entry past the normal two-minute window; the pipeline has not read it yet.
    await t.sql(owner, p.ref, "update realtime.changes set at = now() - interval '10 minutes'");
    answer = 200;
    hits = [];
    await run(c.json.id);
    assert.equal(hits.flatMap((h) => h.body.events).some((e: any) => e.record?.item === "kept"), true);
    await t.api("DELETE", `${base()}/${c.json.id}`, { token: owner });
  });

  describe("extensions", () => {
    const ext = `/v1/projects/${"REF"}/extensions`;
    const path = () => ext.replace("REF", p.ref);
    it("lists what the server offers and marks which can be installed", async () => {
      const r = await t.api("GET", path(), { token: owner });
      assert.equal(r.status, 200);
      const by = Object.fromEntries(r.json.map((e: any) => [e.name, e]));
      assert.equal(by.pg_trgm.installable, true);
      assert.equal(by.pg_trgm.installed, false);
      assert.equal(by.pgcrypto.installed, true);
      assert.equal(by.pgcrypto.protected, true);
      assert.equal((await t.api("GET", path(), { token: dev })).status, 403);
    });
    it("installs a trusted extension into the extensions schema and removes it again", async () => {
      const on = await t.api("POST", path(), { token: owner, body: { name: "pg_trgm", install: true } });
      assert.equal(on.status, 200, on.text);
      assert.equal(on.json.installed, true);
      assert.equal(on.json.schema, "extensions");
      const q = await t.sql(owner, p.ref, "select extensions.similarity('abc', 'abd') as s");
      assert.equal(q.status, 200, q.text);
      assert.equal((await t.api("POST", path(), { token: owner, body: { name: "pg_trgm", install: true } })).status, 200, "installing twice is fine");
      const off = await t.api("POST", path(), { token: owner, body: { name: "pg_trgm", install: false } });
      assert.equal(off.json.installed, false);
      const audit = (await t.api("GET", "/v1/audit-log", { token: owner })).json.map((e: any) => e.action);
      assert.ok(audit.includes("extension.install") && audit.includes("extension.remove"));
    });
    it("refuses protected, unknown, operator-only and malformed requests, and requires admin", async () => {
      assert.equal((await t.api("POST", path(), { token: owner, body: { name: "pgcrypto", install: false } })).status, 403);
      assert.equal((await t.api("POST", path(), { token: owner, body: { name: "does_not_exist", install: true } })).status, 404);
      assert.equal((await t.api("POST", path(), { token: owner, body: { name: 'x"; drop schema public; --', install: true } })).status, 404);
      assert.equal((await t.api("POST", path(), { token: owner, body: { name: "pg_trgm" } })).status, 400);
      assert.equal((await t.api("POST", path(), { token: dev, body: { name: "pg_trgm", install: true } })).status, 403);
      const all = (await t.api("GET", path(), { token: owner })).json as any[];
      const superOnly = all.find((e) => !e.installable && !e.installed);
      if (superOnly) assert.equal((await t.api("POST", path(), { token: owner, body: { name: superOnly.name, install: true } })).status, 403, superOnly.name);
    });
  });
});
