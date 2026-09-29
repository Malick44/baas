import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { signJwt } from "./keys.js";
import { RealtimeHub } from "./realtime.js";
import { makeHarness, type Harness, type TestProject } from "./testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

type Msg = Record<string, any>;

class Client {
  msgs: Msg[] = [];
  ws!: WebSocket;
  closed?: { code: number };
  private waiters: Array<() => void> = [];

  static async open(port: number, p: TestProject, key: string, o: { token?: string } = {}): Promise<Client> {
    const c = new Client();
    const q = new URLSearchParams({ apikey: key });
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/realtime/v1/websocket?${q}`, { headers: { host: p.host } });
    c.ws.on("message", (d) => {
      c.msgs.push(JSON.parse(d.toString()));
      c.waiters.splice(0).forEach((w) => w());
    });
    c.ws.on("error", () => {}); // server-side termination during teardown is expected
    c.ws.on("close", (code) => {
      c.closed = { code };
      c.waiters.splice(0).forEach((w) => w());
    });
    await new Promise<void>((res, rej) => {
      c.ws.once("open", () => res());
      c.ws.once("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
      c.ws.once("error", rej);
    });
    if (o.token) c.send({ type: "access_token", token: o.token });
    return c;
  }

  send(m: Msg) {
    this.ws.send(JSON.stringify(m));
  }

  async waitFor(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting; got ${JSON.stringify(this.msgs)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }

  async subscribe(o: Msg) {
    this.send({ type: "subscribe", ...o });
    return this.waitFor((m) => (m.type === "subscribed" || m.type === "error") && m.ref === o.ref);
  }

  changes = (table?: string) => this.msgs.filter((m) => m.type === "change" && (!table || m.table === table));
  quiet = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  close() {
    this.ws.close();
  }
}

describe("realtime", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let h: Harness;
  let a: TestProject;
  let b: TestProject;
  let port: number;
  const clients: Client[] = [];
  let u1: any, u2: any;

  const open = async (p: TestProject, key: string, o: { token?: string } = {}) => {
    const c = await Client.open(port, p, key, o);
    clients.push(c);
    return c;
  };

  before(async () => {
    h = await makeHarness(ADMIN!, (pm) => ({ services: { realtime: new RealtimeHub(pm, ADMIN!, { checkMs: 300, maxSubsPerConn: 3 }) } }));
    port = await h.listen();
    [a, b] = await Promise.all([h.project(), h.project()]);
    for (const p of [a, b])
      await h.sql(p, `
        CREATE TABLE public.msgs (id serial PRIMARY KEY, owner uuid DEFAULT auth.uid(), room int DEFAULT 1, body text);
        ALTER TABLE public.msgs ENABLE ROW LEVEL SECURITY;
        CREATE POLICY own ON public.msgs FOR ALL TO authenticated USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
        CREATE TABLE public.open (id serial PRIMARY KEY, v text);
        GRANT SELECT ON public.open TO anon;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.msgs, public.open TO authenticated, service_role;
        GRANT USAGE ON SEQUENCE public.msgs_id_seq, public.open_id_seq TO authenticated, service_role;
        CREATE TABLE public.nopk (v text);
        GRANT SELECT ON public.nopk TO anon, authenticated;`);
    const su = async (email: string) => (await h.call(a, "POST", "/auth/v1/signup", { key: a.anon, body: { email, password: "secret123" } })).json;
    u1 = await su("r1@example.com");
    u2 = await su("r2@example.com");
  });
  after(async () => {
    clients.forEach((c) => c.ws.terminate());
    await h?.close();
  });

  const insert = (p: TestProject, token: string, body: unknown) => h.call(p, "POST", "/rest/v1/msgs", { key: p.anon, token, body });

  it("rejects connections without valid credentials or for the wrong project", async () => {
    await assert.rejects(Client.open(port, a, "garbage"), /HTTP 401/);
    await assert.rejects(Client.open(port, b, a.anon), /HTTP 401/);
    await assert.rejects(Client.open(port, { host: "localhost" } as TestProject, a.anon), /HTTP 404/);
    await assert.rejects(Client.open(port, { host: `${"q".repeat(20)}.localhost` } as TestProject, a.anon), /HTTP 404/);
  });

  it("streams inserts, updates and deletes to service_role", async () => {
    const c = await open(a, a.service);
    assert.equal((await c.subscribe({ ref: "s1", table: "open" })).type, "subscribed");
    await h.sql(a, "INSERT INTO public.open (v) VALUES ('one')");
    const ins = await c.waitFor((m) => m.type === "change" && m.event === "INSERT");
    assert.deepEqual(ins.new, { id: 1, v: "one" });
    await h.sql(a, "UPDATE public.open SET v = 'two' WHERE id = 1");
    const upd = await c.waitFor((m) => m.event === "UPDATE");
    assert.equal(upd.new.v, "two");
    await h.sql(a, "DELETE FROM public.open WHERE id = 1");
    const del = await c.waitFor((m) => m.event === "DELETE");
    assert.deepEqual(del.old, { id: 1 });
    assert.equal(del.new, undefined);
  });

  it("applies row-level security to each subscriber", async () => {
    const c1 = await open(a, a.anon, { token: u1.access_token });
    const c2 = await open(a, a.anon, { token: u2.access_token });
    await c1.waitFor((m) => m.type === "access_token_ok");
    await c2.waitFor((m) => m.type === "access_token_ok");
    await c1.subscribe({ ref: "m", table: "msgs" });
    await c2.subscribe({ ref: "m", table: "msgs" });
    await insert(a, u1.access_token, { body: "from one" });
    await insert(a, u2.access_token, { body: "from two" });
    await c1.waitFor((m) => m.new?.body === "from one");
    await c2.waitFor((m) => m.new?.body === "from two");
    await c1.quiet();
    assert.deepEqual(c1.changes("msgs").map((m) => m.new.body), ["from one"]);
    assert.deepEqual(c2.changes("msgs").map((m) => m.new.body), ["from two"]);
  });

  it("withholds RLS-protected deletes from non-service roles but not from service_role", async () => {
    const c1 = await open(a, a.anon, { token: u1.access_token });
    const svc = await open(a, a.service);
    await c1.waitFor((m) => m.type === "connected");
    c1.send({ type: "access_token", token: u1.access_token });
    await c1.subscribe({ ref: "d", table: "msgs", event: "DELETE" });
    await svc.subscribe({ ref: "d", table: "msgs", event: "DELETE" });
    await h.sql(a, "DELETE FROM public.msgs");
    await svc.waitFor((m) => m.event === "DELETE");
    await c1.quiet();
    assert.equal(c1.changes().length, 0);
  });

  it("delivers deletes on tables without RLS to roles that can read them", async () => {
    const anon = await open(a, a.anon);
    await anon.subscribe({ ref: "o", table: "open" });
    await h.sql(a, "INSERT INTO public.open (v) VALUES ('x')");
    await anon.waitFor((m) => m.event === "INSERT");
    const id = anon.changes("open")[0]!.new.id;
    await h.sql(a, "DELETE FROM public.open WHERE id = $1", [id]);
    assert.deepEqual((await anon.waitFor((m) => m.event === "DELETE")).old, { id });
  });

  it("supports filters and event selection", async () => {
    const svc = await open(a, a.service);
    await svc.subscribe({ ref: "f", table: "msgs", event: "INSERT", filter: "room=eq.7" });
    await h.sql(a, "INSERT INTO public.msgs (room, body) VALUES (1, 'skip'), (7, 'keep')");
    await svc.waitFor((m) => m.new?.body === "keep");
    await h.sql(a, "UPDATE public.msgs SET body = 'changed' WHERE room = 7");
    await svc.quiet();
    assert.deepEqual(svc.changes("msgs").map((m) => m.new.body), ["keep"]);
    await h.sql(a, "DELETE FROM public.msgs");
  });

  it("refuses subscriptions the role could not read, without revealing why", async () => {
    const anon = await open(a, a.anon);
    const denied = await anon.subscribe({ ref: "x1", table: "msgs" }); // anon has no grant
    const missing = await anon.subscribe({ ref: "x2", table: "no_such_table" });
    const nopk = await anon.subscribe({ ref: "x3", table: "nopk" });
    for (const r of [denied, missing, nopk]) assert.deepEqual([r.type, r.message], ["error", "cannot subscribe to this table"]);
    for (const [i, t] of ['open"; drop table open;--', "a b", "auth.users", "../x", ""].entries())
      assert.equal((await anon.subscribe({ ref: `bad${i}`, table: t })).type, "error", t);
    assert.equal((await anon.subscribe({ ref: "sch", table: "open", schema: "auth" })).type, "error");
    assert.equal((await anon.subscribe({ ref: "flt", table: "open", filter: "v=bogus.1" })).type, "error");
    assert.equal((await anon.subscribe({ ref: "flt2", table: "open", filter: 'v"=eq.1' })).type, "error");
    assert.equal((await anon.subscribe({ ref: "ev", table: "open", event: "TRUNCATE" })).type, "error");
    assert.equal((await h.sql(a, "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'baas_realtime' AND tgrelid = 'public.nopk'::regclass"))[0].n, 0);
  });

  it("never mixes projects that use the same table name", async () => {
    const ca = await open(a, a.service);
    const cb = await open(b, b.service);
    await ca.subscribe({ ref: "p", table: "open" });
    await cb.subscribe({ ref: "p", table: "open" });
    await h.sql(a, "INSERT INTO public.open (v) VALUES ('only-a')");
    await h.sql(b, "INSERT INTO public.open (v) VALUES ('only-b')");
    await ca.waitFor((m) => m.new?.v === "only-a");
    await cb.waitFor((m) => m.new?.v === "only-b");
    await ca.quiet();
    assert.ok(!ca.changes("open").some((m) => m.new.v === "only-b"));
    assert.ok(!cb.changes("open").some((m) => m.new.v === "only-a"));
  });

  it("stops delivering after unsubscribe", async () => {
    const svc = await open(a, a.service);
    await svc.subscribe({ ref: "u", table: "open" });
    svc.send({ type: "unsubscribe", ref: "u" });
    await svc.quiet(200);
    await h.sql(a, "INSERT INTO public.open (v) VALUES ('after-unsub')");
    await svc.quiet();
    assert.equal(svc.changes().length, 0);
  });

  it("switches identity when the access token changes", async () => {
    const c = await open(a, a.anon, { token: u1.access_token });
    await c.waitFor((m) => m.type === "access_token_ok");
    c.send({ type: "access_token", token: "junk" });
    await c.waitFor((m) => m.type === "error" && /invalid access token/.test(m.message));
    c.send({ type: "access_token", token: signJwt({ role: "service_role", exp: 9999999999 }, b.jwtSecret) }); // other project's secret
    await c.waitFor((m) => m.type === "error" && m.message === "invalid access token" && c.msgs.filter((x) => x.type === "error").length === 2);
  });

  it("survives garbage frames and enforces subscription limits", async () => {
    const c = await open(a, a.service);
    c.ws.send("{not json");
    c.ws.send(Buffer.from([1, 2, 3]));
    c.send({ type: "nonsense" });
    c.send([1, 2]);
    await c.waitFor((m) => m.message === "unknown message type");
    assert.equal(c.msgs.filter((m) => m.type === "error").length, 4);
    c.send({ type: "heartbeat" });
    await c.waitFor((m) => m.type === "heartbeat");
    const big = await open(a, a.service);
    big.ws.send(JSON.stringify({ type: "subscribe", ref: "x".repeat(20000) }));
    await big.waitFor(() => big.closed !== undefined, 2000).catch(() => {});
    assert.ok(big.closed, "oversized frames close the socket");
  });

  it("closes sockets whose token expires or whose project is paused", async () => {
    const shortLived = signJwt({ role: "anon", exp: Math.floor(Date.now() / 1000) + 1 }, a.jwtSecret);
    const c = await open(a, shortLived);
    await c.waitFor(() => c.closed !== undefined, 4000);
    assert.equal(c.closed!.code, 4001);
    const p = await h.project();
    const pc = await open(p, p.service);
    await pc.subscribe({ ref: "z", table: "nothing" });
    await h.control.pauseProject(h.owner, p.ref);
    await pc.waitFor(() => pc.closed !== undefined, 4000);
    assert.equal(pc.closed!.code, 4002);
  });

  it("caps subscriptions per connection", async () => {
    const c = await open(a, a.service);
    for (let i = 0; i < 3; i++) assert.equal((await c.subscribe({ ref: `cap${i}`, table: "open" })).type, "subscribed");
    assert.deepEqual((await c.subscribe({ ref: "cap3", table: "open" })).message, "too many subscriptions");
    assert.equal((await c.subscribe({ ref: "cap0", table: "open" })).type, "subscribed"); // re-subscribing an existing id is fine
  });
});
