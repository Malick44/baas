import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { MemoryMailer } from "./mailer.js";
import { createPlatform, type Platform } from "./platform.js";
import { BOOT, makePlatform } from "./platform-testkit.js";
import { MemorySms } from "./sms.js";
import { UsageService } from "./usage.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("several baas processes on one control database", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let A: Platform;
  let B: Platform;
  let owner: string;
  let orgSlug: string;
  const mail = new MemoryMailer();
  const sms = new MemorySms();
  const via = (n: Platform, ref: string, method: string, url: string, o: { key?: string; body?: unknown; token?: string } = {}) =>
    n.gateway.inject({ method: method as "GET", url, headers: { host: `${ref}.localhost`, ...(o.key ? { apikey: o.key } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}) }, payload: o.body === undefined ? undefined : JSON.stringify(o.body) })
      .then((r) => ({ status: r.statusCode, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })(), text: r.body }));
  const apiVia = (n: Platform, method: string, url: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    n.api.inject({ method: method as "GET", url, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}) }, payload: o.body === undefined ? undefined : JSON.stringify(o.body) })
      .then((r) => ({ status: r.statusCode, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })(), text: r.body }));
  const project = async (name: string, plan = "pro") => {
    const p = await t.project(owner, name);
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan } });
    return p;
  };

  before(async () => {
    t = await makePlatform(ADMIN!, { mail: { mailer: mail }, sms: { sender: sms }, auth: { emailCooldownMs: 600, smsCooldownMs: 600, maxSmsPerHour: 4 } });
    A = t.platform;
    // The second process: same control database, same clusters, same files.
    B = await createPlatform({ ...A.cfg });
    owner = await t.org();
    orgSlug = "mn";
  });
  after(async () => { await B?.stop().catch(() => {}); await t?.close(); });

  it("shares failed-sign-in counts, so spreading guesses over nodes does not multiply them", async () => {
    const p = await project("shared-attempts");
    await via(A, p.ref, "POST", "/auth/v1/signup", { key: p.anon, body: { email: "guess@example.com", password: "password-123" } });
    const wrong = (n: Platform) => via(n, p.ref, "POST", "/auth/v1/token?grant_type=password", { key: p.anon, body: { email: "guess@example.com", password: "wrong-password" } });
    for (let i = 0; i < 5; i++) assert.equal((await wrong(A)).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await wrong(B)).status, 400);
    const locked = await via(B, p.ref, "POST", "/auth/v1/token?grant_type=password", { key: p.anon, body: { email: "guess@example.com", password: "password-123" } });
    assert.equal(locked.status, 429, "ten misses across two nodes lock the address on both, even for the right password");
    assert.equal((await via(A, p.ref, "POST", "/auth/v1/token?grant_type=password", { key: p.anon, body: { email: "guess@example.com", password: "password-123" } })).status, 429);
  });

  it("shares send cooldowns and hourly caps for email and text messages", async () => {
    const p = await project("shared-sends");
    await t.api("PATCH", `/v1/projects/${p.ref}/settings`, { token: owner, body: { email_confirm: false, site_url: "https://app.example.com" } });
    await via(A, p.ref, "POST", "/auth/v1/signup", { key: p.anon, body: { email: "once@example.com", password: "password-123" } });
    const recover = (n: Platform) => via(n, p.ref, "POST", "/auth/v1/recover", { key: p.anon, body: { email: "once@example.com" } });
    A.dir.forget(p.ref); B.dir.forget(p.ref);
    assert.equal((await recover(A)).status, 200);
    const again = await recover(B);
    assert.equal(again.status, 429, "the cooldown started on the other node still applies");
    assert.equal(again.json.error_code, "over_email_send_rate_limit");
    await sleep(700);
    assert.equal((await recover(B)).status, 200, "and ends for both");

    const text = (n: Platform, phone: string) => via(n, p.ref, "POST", "/auth/v1/otp", { key: p.anon, body: { phone } });
    assert.equal((await text(A, "+14155550201")).status, 200);
    assert.equal((await text(B, "+14155550201")).status, 429, "same number, other node");
    assert.equal((await text(B, "+14155550202")).status, 200);
    assert.equal((await text(A, "+14155550203")).status, 200);
    assert.equal((await text(B, "+14155550204")).status, 200);
    const capped = await text(A, "+14155550205");
    assert.equal(capped.status, 429, "four texts this hour across both nodes is the cap");
    assert.match(capped.json.msg ?? capped.json.message ?? capped.text, /too many text messages/);
  });

  it("shares dashboard sign-in throttling", async () => {
    const slug = `mn-${Date.now() % 100000}`;
    const r = await apiVia(A, "POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "Shared", slug, owner_email: "dash@example.com", owner_password: "correct-horse-battery" } });
    assert.equal(r.status, 201, r.text);
    void orgSlug;
    const login = (n: Platform, pw: string) => apiVia(n, "POST", "/v1/auth/login", { body: { email: "dash@example.com", password: pw } });
    for (let i = 0; i < 5; i++) assert.equal((await login(A, "nope-nope-nope")).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await login(B, "nope-nope-nope")).status, 401);
    assert.equal((await login(A, "correct-horse-battery")).status, 429);
    assert.equal((await login(B, "correct-horse-battery")).status, 429);
  });

  it("elects exactly one leader, shows it to the operator, and hands over when it stops", async () => {
    await A.coordinator.start();
    await B.coordinator.start();
    await A.coordinator.beat(); // counts are refreshed on each heartbeat, so the first node learns of the second at its next one
    assert.equal(A.coordinator.isLeader(), true, "the first to ask leads");
    assert.equal(B.coordinator.isLeader(), false);
    const list = (await apiVia(B, "GET", "/v1/admin/nodes", { headers: { "x-bootstrap-token": BOOT } })).json;
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((n: any) => n.leader), [true, false], "oldest first, and only one leader");
    assert.deepEqual(list.map((n: any) => n.self), [false, true], "each node knows which row is itself");
    assert.equal(A.coordinator.nodeCount(), 2);
    assert.equal((await apiVia(B, "GET", "/v1/admin/nodes")).status, 401);

    await A.coordinator.stop();
    await B.coordinator.beat();
    assert.equal(B.coordinator.isLeader(), true, "the survivor takes over");
    const after = (await apiVia(B, "GET", "/v1/admin/nodes", { headers: { "x-bootstrap-token": BOOT } })).json;
    assert.deepEqual(after.map((n: any) => [n.self, n.leader]), [[true, true]], "and the stopped node is gone from the list");

    await A.coordinator.start();
    assert.equal(A.coordinator.isLeader(), false, "a node that comes back does not take leadership from a healthy leader");
    assert.equal(B.coordinator.isLeader(), true);
    await A.coordinator.stop();
    await B.coordinator.stop();
  });

  it("runs housekeeping and webhook delivery on the leader only, and the new leader takes over", async () => {
    const ticks = { A: 0, B: 0 };
    A.pipelines.tick = async () => { ticks.A++; return 0; };
    B.pipelines.tick = async () => { ticks.B++; return 0; };
    await A.start(60, 40); // leader: the first node to ask
    await B.start(60, 40);
    await sleep(900);
    assert.ok(A.lastHousekeep && A.lastHousekeep.report, "the leader did the housekeeping");
    assert.equal(B.lastHousekeep, undefined, "the follower did not");
    assert.ok(ticks.A > 3 && ticks.B === 0, `webhooks were delivered by the leader only (${JSON.stringify(ticks)})`);

    await A.coordinator.stop();
    await B.coordinator.beat();
    const before = ticks.B;
    await sleep(900);
    assert.ok(ticks.B > before, "after the handover the other node delivers");
    assert.ok(B.lastHousekeep, "and does the housekeeping");
  });

  it("splits the rate limit between the nodes that are alive", async () => {
    // A fixed clock makes the count exact: the free plan allows 40 requests at once, then 20 a second.
    const p = await project("rate-split", "free");
    const resolved = (await A.dir.get(p.ref))!;
    const request = { method: "GET", url: "/rest/v1/" } as never;
    const allowed = async (nodes: number) => {
      const usage = new UsageService(A.control, ADMIN!, undefined, () => 1_000_000, () => nodes);
      let ok = 0;
      for (let i = 0; i < 70; i++) { try { await usage.admit(p.ref, resolved, request); ok++; } catch (e) { assert.equal((e as { status: number }).status, 429); } }
      return ok;
    };
    assert.equal(await allowed(1), 40, "one node allows the plan's whole burst");
    assert.equal(await allowed(2), 20, "two nodes allow half each");
    assert.equal(await allowed(3), 13, "three allow a third each");
    assert.equal(await allowed(0), 40, "never divides by nothing");

    // And the coordinator feeds it the live count: two nodes beating means two.
    await A.coordinator.start();
    await B.coordinator.start();
    await A.coordinator.beat();
    await B.coordinator.beat();
    assert.equal(A.coordinator.nodeCount(), 2);
    assert.equal(B.coordinator.nodeCount(), 2);
    await A.coordinator.stop();
    await B.coordinator.beat();
    assert.equal(B.coordinator.nodeCount(), 1, "a node that stopped no longer counts");
    await B.coordinator.stop();
  });

  it("shows request and function logs from every node", async () => {
    const p = await project("shared-logs");
    await via(A, p.ref, "GET", "/rest/v1/from-a", { key: p.anon });
    await via(B, p.ref, "GET", "/rest/v1/from-b", { key: p.anon });
    await B.usage.flush(); // in production this happens every couple of seconds
    const logs = (await apiVia(A, "GET", `/v1/projects/${p.ref}/logs`, { token: owner })).json as Array<{ path: string }>;
    assert.ok(logs.some((l) => l.path === "/rest/v1/from-a") && logs.some((l) => l.path === "/rest/v1/from-b"), `both nodes' requests are listed: ${logs.map((l) => l.path)}`);
    assert.equal(JSON.stringify((await apiVia(B, "GET", `/v1/projects/${p.ref}/logs`, { token: owner })).json), JSON.stringify(logs), "the same from either node");

    await t.api("PUT", `/v1/projects/${p.ref}/functions/ping`, { token: owner, body: { source: "export default async () => Response.json({ pong: true });" } });
    A.dir.forget(p.ref); B.dir.forget(p.ref);
    assert.equal((await via(A, p.ref, "POST", "/functions/v1/ping", { key: p.service, token: p.service })).status, 200);
    assert.equal((await via(B, p.ref, "POST", "/functions/v1/ping", { key: p.service, token: p.service })).status, 200);
    const fl = (await apiVia(B, "GET", `/v1/projects/${p.ref}/functions/ping/logs`, { token: owner })).json as unknown[];
    assert.equal(fl.length, 2, "one invocation on each node, both visible");
  });

  it("serves a change made through one node to a realtime subscriber on the other", async () => {
    const p = await project("shared-realtime");
    await t.sql(owner, p.ref, "create table public.feed (id serial primary key, msg text); grant select on public.feed to anon; grant all on public.feed to service_role; grant usage on sequence public.feed_id_seq to service_role");
    const ports = await B.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
    const ws = new WebSocket(`ws://127.0.0.1:${ports.gateway}/realtime/v1/websocket?apikey=${p.service}`, { headers: { host: `${p.ref}.localhost` } });
    const got: any[] = [];
    ws.on("message", (d) => got.push(JSON.parse(d.toString())));
    ws.on("error", () => {});
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
    ws.send(JSON.stringify({ type: "subscribe", ref: "f", table: "feed" }));
    for (let i = 0; i < 40 && !got.some((m) => m.type === "subscribed"); i++) await sleep(100);
    assert.ok(got.some((m) => m.type === "subscribed"), JSON.stringify(got));
    // The write goes through node A's data plane.
    assert.equal((await via(A, p.ref, "POST", "/rest/v1/feed", { key: p.service, token: p.service, body: { msg: "hello from A" } })).status, 201);
    for (let i = 0; i < 40 && !got.some((m) => m.type === "change"); i++) await sleep(100);
    ws.terminate();
    const change = got.find((m) => m.type === "change");
    assert.equal(change?.new?.msg, "hello from A", JSON.stringify(got));
  });

  it("sees a pause made on another node once its short cache expires", async () => {
    const p = await project("shared-pause");
    assert.equal((await via(B, p.ref, "GET", "/rest/v1/", { key: p.anon })).status, 200);
    assert.equal((await apiVia(A, "POST", `/v1/projects/${p.ref}/pause`, { token: owner })).status, 200);
    await sleep(2300);
    assert.equal((await via(B, p.ref, "GET", "/rest/v1/", { key: p.anon })).status, 503, "the other node stops serving it within the cache lifetime");
    assert.equal((await apiVia(B, "POST", `/v1/projects/${p.ref}/resume`, { token: owner })).status, 200);
    await sleep(2300);
    assert.equal((await via(A, p.ref, "GET", "/rest/v1/", { key: p.anon })).status, 200, "and resumed from the other");
  });

  it("starts a second node against a database the first has already migrated", async () => {
    const third = await createPlatform({ ...A.cfg });
    try {
      assert.deepEqual(await third.migrations, [], "nothing left to apply");
      assert.equal((await apiVia(third, "GET", "/healthz")).status, 200);
    } finally { await third.stop(); }
  });
});
