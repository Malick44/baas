import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makePlatform } from "./platform-testkit.js";
import { createClient } from "./client.js";
import { MemorySms, TwilioSms } from "./sms.js";
import { verifyJwt } from "./keys.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("phone sign-in", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  const sms = new MemorySms();
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let off: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<typeof t.project>>;
  const gw = (m: string, u: string, body?: unknown) => t.gw(p.ref, m, u, { key: p.anon, body });
  const codeTo = (to: string) => /(\d{6})/.exec(sms.last(to)!.body)![1]!;
  const settings = (patch: object) => t.api("PATCH", `/v1/projects/${p.ref}/settings`, { token: owner, body: patch }).then((r) => { t.platform.dir.forget(p.ref); return r; });
  const rows = async (q: string): Promise<any[][]> => {
    const j = (await t.sql(owner, p.ref, q)).json;
    return (Array.isArray(j) ? j : j.results).at(-1).rows;
  };

  before(async () => {
    t = await makePlatform(ADMIN!, { sms: { sender: sms }, auth: { smsCooldownMs: 150, maxSmsPerHour: 40 } });
    off = await makePlatform(ADMIN!);
    owner = await t.org();
    p = await t.project(owner, "phone");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
  });
  after(async () => { await t?.close(); await off?.close(); });
  const wait = () => new Promise((r) => setTimeout(r, 170));

  it("is off, and says so, when no text provider is configured", async () => {
    const o = await off.org();
    const op = await off.project(o, "nophone");
    const g = (u: string, body: unknown) => off.gw(op.ref, "POST", u, { key: op.anon, body });
    assert.equal((await off.gw(op.ref, "GET", "/auth/v1/settings", { key: op.anon })).json.external.phone, false);
    assert.equal((await g("/auth/v1/otp", { phone: "+14155550100" })).status, 501);
    assert.equal((await g("/auth/v1/signup", { phone: "+14155550100", password: "password-123" })).status, 501);
    assert.equal((await g("/auth/v1/verify", { phone: "+14155550100", token: "123456", type: "sms" })).status, 501);
    assert.equal((await t.api("GET", `/v1/projects/${p.ref}/auth-config`, { token: owner })).json.sms_delivery, true);
    assert.equal((await off.api("GET", `/v1/projects/${op.ref}/auth-config`, { token: o })).json.sms_delivery, false);
    assert.equal((await gw("GET", "/auth/v1/settings")).json.external.phone, true);
  });

  it("signs up with a phone and password, texts a code, and only lets them in once it is confirmed", async () => {
    const r = await gw("POST", "/auth/v1/signup", { phone: "+1 (415) 555-0101", password: "password-123" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.phone, "+14155550101", "stored in international form");
    assert.equal(r.json.access_token, undefined, "no session before the number is confirmed");
    assert.equal(r.json.phone_confirmed_at, null);
    const text = sms.last("+14155550101")!;
    assert.match(text.body, /^Your verification code is \d{6}$/);
    assert.equal((await gw("POST", "/auth/v1/token?grant_type=password", { phone: "+14155550101", password: "password-123" })).json.error_code, "phone_not_confirmed");

    assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550101", token: "000000", type: "sms" })).status, 403);
    const v = await gw("POST", "/auth/v1/verify", { phone: "+14155550101", token: codeTo("+14155550101"), type: "sms" });
    assert.equal(v.status, 200, v.text);
    assert.equal(v.json.user.phone, "+14155550101");
    assert.ok(v.json.user.phone_confirmed_at);
    assert.equal(v.json.user.email, null);
    assert.equal(v.json.user.app_metadata.provider, "phone");
    assert.equal(verifyJwt(v.json.access_token, await jwtSecret())?.phone, "+14155550101", "the token carries the number");
    assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550101", token: codeTo("+14155550101"), type: "sms" })).status, 403, "a code works once");
    const login = await gw("POST", "/auth/v1/token?grant_type=password", { phone: "+14155550101", password: "password-123" });
    assert.equal(login.status, 200, login.text);
    assert.equal((await gw("POST", "/auth/v1/token?grant_type=password", { phone: "+14155550101", password: "wrong-password" })).json.error_code, "invalid_credentials");
    const me = await t.gw(p.ref, "GET", "/auth/v1/user", { key: p.anon, headers: { authorization: `Bearer ${login.json.access_token}` } });
    assert.equal(me.json.phone, "+14155550101");
  });

  async function jwtSecret() {
    return (await t.platform.dir.get(p.ref))!.secrets!.jwtSecret;
  }

  it("signs in by text alone, creating the account the first time, and answers the same for everyone", async () => {
    await wait();
    const a = await gw("POST", "/auth/v1/otp", { phone: "+14155550102" });
    assert.equal(a.status, 200);
    const v = await gw("POST", "/auth/v1/verify", { phone: "+14155550102", token: codeTo("+14155550102"), type: "sms" });
    assert.equal(v.status, 200, v.text);
    await wait();
    await gw("POST", "/auth/v1/otp", { phone: "+14155550102" });
    assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550102", token: codeTo("+14155550102"), type: "sms" })).status, 200, "the same person again");
    assert.equal((await rows("select count(*)::int from auth.users where phone = '+14155550102'"))[0]![0], 1);
    await wait();
    const before = sms.outbox.length;
    assert.equal((await gw("POST", "/auth/v1/otp", { phone: "+14155550103", create_user: false })).status, 200, "same answer, nothing created");
    assert.equal(sms.outbox.length, before);
    assert.equal((await rows("select count(*)::int from auth.users where phone = '+14155550103'"))[0]![0], 0);
  });

  it("refuses badly formed numbers, duplicates, and sign-ups when they are switched off", async () => {
    await wait();
    for (const bad of ["4155550100", "+0123456789", "+1", "+1415555010000000000", "abc", 5, null, ""]) assert.equal((await gw("POST", "/auth/v1/otp", { phone: bad })).status, 422, String(bad));
    await wait();
    assert.equal((await gw("POST", "/auth/v1/signup", { phone: "+14155550101", password: "password-123" })).status, 422, "already registered");
    await wait();
    assert.equal((await gw("POST", "/auth/v1/signup", { phone: "+14155550104", password: "123" })).status, 422);
    assert.equal((await settings({ disable_signup: true })).status, 200);
    await wait();
    assert.equal((await gw("POST", "/auth/v1/signup", { phone: "+14155550105", password: "password-123" })).status, 422);
    const before = sms.outbox.length;
    await gw("POST", "/auth/v1/otp", { phone: "+14155550106" });
    assert.equal(sms.outbox.length, before, "no text and no account for a stranger");
    await settings({ disable_signup: false });
  });

  it("gives a code five tries and ten minutes, and only the newest code works", async () => {
    await wait();
    await gw("POST", "/auth/v1/otp", { phone: "+14155550107" });
    const good = codeTo("+14155550107");
    const wrong = good === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550107", token: wrong, type: "sms" })).status, 403);
    assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550107", token: good, type: "sms" })).status, 403, "even the right code after five misses");

    await wait();
    await gw("POST", "/auth/v1/otp", { phone: "+14155550108" });
    const first = codeTo("+14155550108");
    await wait();
    await gw("POST", "/auth/v1/otp", { phone: "+14155550108" });
    const second = codeTo("+14155550108");
    if (first !== second) assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550108", token: first, type: "sms" })).status, 403, "the older code is dead");
    await rows("update auth.phone_codes set expires_at = now() - interval '1 second'");
    assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550108", token: second, type: "sms" })).status, 403, "expired");
    assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550108", token: "12345", type: "sms" })).status, 403);
    assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550108", token: second, type: "magiclink" })).status, 422);
  });

  it("limits how often a number can be texted, and keeps the code out of the database", async () => {
    await wait();
    assert.equal((await gw("POST", "/auth/v1/otp", { phone: "+14155550109" })).status, 200);
    assert.equal((await gw("POST", "/auth/v1/otp", { phone: "+14155550109" })).status, 429, "too soon");
    const stored = await rows("select code_hash from auth.phone_codes order by created_at desc limit 1");
    assert.match(String(stored[0]![0]), /^[0-9a-f]{64}$/);
    assert.equal(String(stored[0]![0]).includes(codeTo("+14155550109")), false);
  });

  it("refuses to sign a banned user in by text", async () => {
    await wait();
    await gw("POST", "/auth/v1/otp", { phone: "+14155550110" });
    await rows("update auth.users set banned_until = now() + interval '1 day' where phone = '+14155550110'");
    assert.equal((await gw("POST", "/auth/v1/verify", { phone: "+14155550110", token: codeTo("+14155550110"), type: "sms" })).status, 400);
  });

  it("uses a custom message, which must contain the code", async () => {
    assert.equal((await settings({ sms_template: "no code here" })).status, 400);
    assert.equal((await settings({ sms_template: "x".repeat(161) + "{{ .Token }}" })).status, 400);
    assert.equal((await settings({ sms_template: "Acme: {{ .Token }} is your code" })).status, 200);
    await wait();
    await gw("POST", "/auth/v1/otp", { phone: "+14155550111" });
    assert.match(sms.last("+14155550111")!.body, /^Acme: \d{6} is your code$/);
  });

  it("works through the client library", async () => {
    await wait();
    const base = `http://${p.ref}.localhost:8081`;
    const c = createClient(base, p.anon, { fetch: ((u: string, i: RequestInit) => t.platform.gateway.inject({ method: (i.method ?? "GET") as "GET", url: String(u).replace(base, ""), headers: { ...(i.headers as Record<string, string>), host: `${p.ref}.localhost` }, payload: i.body as string }).then((r) => new Response(r.body, { status: r.statusCode, headers: r.headers as Record<string, string> }))) as typeof fetch });
    assert.equal((await c.auth.signInWithOtp({ phone: "+14155550112" })).error, null);
    const v = await c.auth.verifyOtp({ type: "sms", phone: "+14155550112", token: codeTo("+14155550112") });
    assert.equal(v.error, null, JSON.stringify(v.error));
    assert.equal(v.data!.user.phone, "+14155550112");
    await c.auth.signOut();
    await wait();
    assert.equal((await c.auth.signUp({ phone: "+14155550113", password: "password-123" })).error, null);
  });

  it("sends through Twilio's Messages API", async () => {
    const seen: { url: string; auth: string; form: URLSearchParams }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization!, form: init.body as URLSearchParams });
      return new Response(JSON.stringify(seen.length === 3 ? { message: "The 'To' number is not valid", code: 21211 } : { sid: "SM1" }), { status: seen.length === 3 ? 400 : 201 });
    }) as unknown as typeof fetch;
    const sid = `AC${"a".repeat(32)}`;
    await new TwilioSms({ accountSid: sid, authToken: "tok", from: "+15005550006", fetch: fake }).send({ to: "+14155550100", body: "hi" });
    await new TwilioSms({ accountSid: sid, authToken: "tok", from: `MG${"b".repeat(32)}`, fetch: fake }).send({ to: "+14155550100", body: "hi" });
    assert.equal(seen[0]!.url, `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    assert.equal(seen[0]!.auth, `Basic ${Buffer.from(`${sid}:tok`).toString("base64")}`);
    assert.deepEqual([...seen[0]!.form], [["To", "+14155550100"], ["Body", "hi"], ["From", "+15005550006"]]);
    assert.equal(seen[1]!.form.get("MessagingServiceSid"), `MG${"b".repeat(32)}`);
    assert.equal(seen[1]!.form.has("From"), false);
    await assert.rejects(new TwilioSms({ accountSid: sid, authToken: "tok", from: "+1", fetch: fake }).send({ to: "+1", body: "x" }), /Twilio answered 400: The 'To' number is not valid/);
    assert.throws(() => new TwilioSms({ accountSid: "nope", authToken: "t", from: "+1" }), /ACCOUNT_SID/);
  });

  it("upgrades projects that predate phone sign-in", async () => {
    const o = await t.project(owner, "legacy-phone");
    const c = new (await import("pg")).default.Client({ connectionString: o.dbUrl });
    await c.connect();
    await c.query("DROP TABLE auth.phone_codes; DROP INDEX auth.users_phone_key; ALTER TABLE auth.users DROP COLUMN phone, DROP COLUMN phone_confirmed_at");
    await c.end();
    const g = (m: string, u: string, body?: unknown) => t.gw(o.ref, m, u, { key: o.anon, body });
    await wait();
    assert.equal((await g("POST", "/auth/v1/otp", { phone: "+14155550120" })).status, 200);
    const v = await g("POST", "/auth/v1/verify", { phone: "+14155550120", token: codeTo("+14155550120"), type: "sms" });
    assert.equal(v.status, 200, v.text);
    assert.equal(v.json.user.phone, "+14155550120");
  });
});
