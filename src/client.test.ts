import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Agent, fetch as ufetch } from "undici";
import { WebSocket as WS } from "ws";
import { createClient, type BaasClient } from "./client.js";
import { MemoryMailer } from "./mailer.js";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

const lookup = (_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
const agent = new Agent({ connect: { lookup } });
const dnsFetch = ((input: any, init: any) => ufetch(input, { ...init, dispatcher: agent })) as unknown as typeof fetch;
class LocalWS extends WS {
  constructor(url: string) {
    super(url, { lookup } as any);
  }
}

describe("client sdk", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let url: string;
  let anon: BaasClient;
  let admin: BaasClient;
  let ref: string;
  let keys: { anon: string; service: string };

  const mk = (key: string, extra = {}) => createClient(url, key, { fetch: dnsFetch, WebSocket: LocalWS as any, ...extra });
  const wait = async (cond: () => boolean, label = "condition", ms = 4000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  before(async () => {
    t = await makePlatform(ADMIN!);
    const ports = await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
    const owner = await t.org();
    const p = await t.project(owner, "sdk");
    ref = p.ref;
    await t.api("PATCH", `/v1/projects/${ref}`, { token: owner, body: { plan: "pro" } }); // this suite is about the SDK, not rate limits
    keys = { anon: p.anon, service: p.service };
    url = `http://${ref}.localhost:${ports.gateway}`;
    const setup = await t.sql(owner, ref, `
      CREATE TABLE public.todos (id serial PRIMARY KEY, owner uuid DEFAULT auth.uid(), title text NOT NULL, done boolean NOT NULL DEFAULT false, prio int DEFAULT 0);
      ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO authenticated;
      GRANT USAGE ON SEQUENCE public.todos_id_seq TO authenticated;
      CREATE POLICY mine ON public.todos FOR ALL TO authenticated USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
      CREATE FUNCTION public.double(n int) RETURNS int LANGUAGE sql AS 'SELECT n * 2';
      GRANT EXECUTE ON FUNCTION public.double TO anon, authenticated;
      CREATE POLICY read_avatars ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'files');
      CREATE POLICY write_avatars ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'files');
      CREATE POLICY update_avatars ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'files') WITH CHECK (bucket_id = 'files')`);
    assert.equal(setup.status, 200, setup.text);
    await t.api("PUT", `/v1/projects/${ref}/functions/greet`, { token: owner, body: { source: `export default async (req) => { const { name } = await req.json(); return Response.json({ hello: name, url: process.env.SUPABASE_URL }); }` } });
    anon = mk(keys.anon);
    admin = mk(keys.service);
  });
  after(async () => {
    anon?.removeAllChannels();
    admin?.removeAllChannels();
    await t?.close();
  });

  it("signs up, signs in, reads the user and signs out", async () => {
    const events: string[] = [];
    anon.auth.onAuthStateChange((e) => events.push(e));
    const up = await anon.auth.signUp({ email: "sdk@example.com", password: "secret123", options: { data: { name: "Sam" } } });
    assert.equal(up.error, null);
    assert.equal(up.data!.user!.user_metadata.name, "Sam");
    const dup = await mk(keys.anon).auth.signUp({ email: "sdk@example.com", password: "secret123" });
    assert.equal(dup.error?.code, "user_already_exists");
    const bad = await mk(keys.anon).auth.signInWithPassword({ email: "sdk@example.com", password: "nope-nope" });
    assert.equal(bad.error?.message, "Invalid login credentials");
    const me = await anon.auth.getUser();
    assert.equal(me.data!.user.email, "sdk@example.com");
    assert.equal((await anon.auth.updateUser({ data: { theme: "dark" } })).data!.user.user_metadata.theme, "dark");
    assert.deepEqual(events, ["SIGNED_IN", "USER_UPDATED"]);
  });

  it("queries with filters, ordering, pagination, counts and single()", async () => {
    const ins = await anon.from("todos").insert([{ title: "b", prio: 2, done: false }, { title: "a", prio: 1, done: false }, { title: "c", prio: 3, done: true }]).select();
    assert.equal(ins.error, null);
    assert.equal(ins.data!.length, 3);
    assert.deepEqual((await anon.from("todos").select("title").order("prio", { ascending: false })).data, [{ title: "c" }, { title: "b" }, { title: "a" }]);
    assert.deepEqual((await anon.from("todos").select("title").eq("done", false).order("title")).data!.map((r) => r.title), ["a", "b"]);
    assert.deepEqual((await anon.from("todos").select("title").in("title", ["a", "c"]).order("title")).data!.map((r) => r.title), ["a", "c"]);
    assert.deepEqual((await anon.from("todos").select("title").or("prio.eq.1,prio.eq.3").order("prio")).data!.map((r) => r.title), ["a", "c"]);
    assert.deepEqual((await anon.from("todos").select("title").gte("prio", 2).not("title", "eq", "c")).data, [{ title: "b" }]);
    assert.deepEqual((await anon.from("todos").select("title").order("title").range(1, 1)).data, [{ title: "b" }]);
    const counted = await anon.from("todos").select("*", { count: "exact" }).limit(1);
    assert.equal(counted.count, 3);
    assert.equal((await anon.from("todos").select("title").eq("title", "a").single()).data!.title, "a");
    assert.equal((await anon.from("todos").select("*").single()).error?.code, "PGRST116");
    assert.deepEqual(await anon.from("todos").select("*").eq("title", "zzz").maybeSingle().then((r) => [r.data, r.error]), [null, null]);
    assert.equal((await anon.from("todos").select("title").in("title", ["a,b", 'x"y']).then((r) => r.data!.length)), 0); // awkward values are quoted, not injected
  });

  it("updates, upserts and deletes, and RLS hides other users' rows", async () => {
    assert.equal((await anon.from("todos").update({ done: true }).eq("title", "a")).error, null);
    assert.equal((await anon.from("todos").select("done").eq("title", "a").single()).data!.done, true);
    const up = await anon.from("todos").upsert({ id: 1, title: "renamed", prio: 9 }).select();
    assert.equal(up.data![0]!.title, "renamed");
    const other = mk(keys.anon);
    await other.auth.signUp({ email: "other@example.com", password: "secret123" });
    assert.deepEqual((await other.from("todos").select("*")).data, []);
    assert.equal((await other.from("todos").delete().eq("title", "renamed").select()).data!.length, 0);
    assert.equal((await anon.from("todos").delete().eq("title", "renamed").select()).data!.length, 1);
    assert.match((await anon.from("todos").delete()).error!.message, /unfiltered/);
  });

  it("calls rpc, and reports errors with status and code", async () => {
    assert.equal((await anon.rpc("double", { n: 21 })).data, 42);
    assert.equal((await anon.rpc("double", { n: 4 }, { get: true })).data, 8);
    const e = await anon.from("missing_table").select("*");
    assert.equal(e.status, 404);
    assert.ok(e.error?.message);
  });

  it("uploads, lists, signs, downloads, moves and removes files", async () => {
    assert.equal((await admin.storage.createBucket("files", { public: false })).error, null);
    assert.equal((await admin.storage.createBucket("public-files", { public: true })).error, null);
    assert.equal((await anon.storage.createBucket("nope")).status, 403);
    const up = await anon.storage.from("files").upload("docs/hello.txt", "hello storage", { contentType: "text/plain" });
    assert.equal(up.error, null);
    assert.equal((await anon.storage.from("files").upload("docs/hello.txt", "again")).status, 409);
    assert.equal((await anon.storage.from("files").upload("docs/hello.txt", "again", { upsert: true })).error, null);
    const dl = await anon.storage.from("files").download("docs/hello.txt");
    assert.equal(await dl.data!.text(), "again");
    assert.deepEqual((await anon.storage.from("files").list("docs")).data!.map((f) => f.name), ["hello.txt"]);
    const signed = await anon.storage.from("files").createSignedUrl("docs/hello.txt", 60);
    assert.equal(await (await dnsFetch(signed.data!.signedUrl)).text(), "again");
    await admin.storage.from("public-files").upload("a b.txt", new Uint8Array([104, 105]), { contentType: "text/plain" });
    const pub = admin.storage.from("public-files").getPublicUrl("a b.txt").data.publicUrl;
    assert.equal(await (await dnsFetch(pub)).text(), "hi");
    assert.equal((await admin.storage.from("files").move("docs/hello.txt", "docs/moved.txt")).error, null);
    assert.equal((await admin.storage.from("files").remove(["docs/moved.txt"])).data!.length, 1);
  });

  it("invokes functions with JSON bodies", async () => {
    const r = await anon.functions.invoke("greet", { body: { name: "Ann" } });
    assert.equal(r.error, null);
    assert.equal(r.data.hello, "Ann");
    assert.match(r.data.url, /^http:\/\/[a-z0-9]{20}\.localhost:8081$/);
    assert.equal((await anon.functions.invoke("nope")).status, 404);
  });

  it("streams realtime changes and honours unsubscribe", async () => {
    const seen: any[] = [];
    const statuses: string[] = [];
    const ch = anon.channel("todos-feed").on("postgres_changes", { event: "*", schema: "public", table: "todos" }, (p) => seen.push(p)).subscribe((s) => statuses.push(s));
    await wait(() => statuses.includes("SUBSCRIBED"), `SUBSCRIBED (got ${JSON.stringify(statuses)})`);
    await anon.from("todos").insert({ title: "live" });
    await wait(() => seen.some((p) => p.eventType === "INSERT" && p.new.title === "live"), "INSERT");
    await anon.from("todos").update({ prio: 5 }).eq("title", "live");
    await wait(() => seen.some((p) => p.eventType === "UPDATE" && p.new.prio === 5), "UPDATE");
    // Another user's writes are not delivered (RLS).
    const other = mk(keys.anon);
    await other.auth.signInWithPassword({ email: "other@example.com", password: "secret123" });
    await other.from("todos").insert({ title: "theirs" });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!seen.some((p) => p.new?.title === "theirs"));
    ch.unsubscribe();
    await new Promise((r) => setTimeout(r, 200));
    const n = seen.length;
    await anon.from("todos").insert({ title: "after" });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(seen.length, n);
  });

  it("refreshes an expiring session by itself and ends it on sign out", async () => {
    const c = mk(keys.anon);
    const s = (await c.auth.signInWithPassword({ email: "sdk@example.com", password: "secret123" })).data!.session;
    const stale = { ...s, expires_at: Math.floor(Date.now() / 1000) + 5 };
    const store = new Map<string, string>();
    const c2 = mk(keys.anon, { storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
    store.set(`baas.auth.${new URL(url).host}`, JSON.stringify(stale));
    const c3 = mk(keys.anon, { storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
    void c2;
    const events: string[] = [];
    c3.auth.onAuthStateChange((e) => events.push(e));
    assert.equal((await c3.from("todos").select("title").limit(1)).error, null); // this call refreshes first
    assert.deepEqual(events, ["TOKEN_REFRESHED"]);
    const refreshed = JSON.parse(store.get(`baas.auth.${new URL(url).host}`)!);
    assert.notEqual(refreshed.refresh_token, s.refresh_token); // rotated
    await c3.auth.signOut();
    assert.equal((await c3.auth.getUser()).error?.message, "Auth session missing");
    // The old refresh token no longer works.
    const dead = await (dnsFetch(`${url}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: keys.anon, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: refreshed.refresh_token }) }));
    assert.equal(dead.status, 400);
  });
});

describe("client sdk: email and provider sign-in", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let c: BaasClient;
  let owner: string;
  let ref: string;
  let gwPort: number;
  const mail = new MemoryMailer();
  const noRedirect: typeof fetch = ((input: any, init: any) => ufetch(input, { ...init, redirect: "manual", dispatcher: agent })) as unknown as typeof fetch;

  before(async () => {
    t = await makePlatform(ADMIN!, { mail: { mailer: mail }, auth: { emailCooldownMs: 0 } });
    const ports = await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
    gwPort = ports.gateway;
    owner = await t.org();
    const p = await t.project(owner, "sdk-auth");
    ref = p.ref;
    await t.api("PATCH", `/v1/projects/${ref}/settings`, { token: owner, body: { email_confirm: true, site_url: "https://app.example.com" } });
    t.platform.dir.forget(ref);
    c = createClient(`http://${ref}.localhost:${gwPort}`, p.anon, { fetch: dnsFetch });
  });
  after(() => t?.close());

  const link = (to: string) => /(http:\/\/\S+\/auth\/v1\/verify\?token=[\w-]+&type=\w+)/.exec(mail.last(to)!.text)![1]!;
  const follow = async (u: string) => (await noRedirect(u.replace(":8081", `:${gwPort}`), { redirect: "manual" } as any)).headers.get("location")!; // the link names the configured public port

  it("signs up without a session, then confirms through the emailed link and reads the session from the URL", async () => {
    const s = await c.auth.signUp({ email: "sdk@example.com", password: "password-123", options: { emailRedirectTo: "https://app.example.com/welcome" } });
    assert.equal(s.error, null);
    assert.equal(s.data!.session, null);
    assert.equal(s.data!.user!.email, "sdk@example.com");
    assert.equal((await c.auth.getSession()).data!.session, null);
    assert.equal((await c.auth.signInWithPassword({ email: "sdk@example.com", password: "password-123" })).error!.code, "email_not_confirmed");
    const landed = await follow(link("sdk@example.com"));
    assert.match(landed, /^https:\/\/app\.example\.com\/welcome#access_token=/);
    const r = await c.auth.getSessionFromUrl(landed);
    assert.equal(r.error, null, JSON.stringify(r.error));
    assert.equal(r.data!.type, "signup");
    assert.equal((await c.auth.getUser()).data!.user.email, "sdk@example.com");
    assert.equal((await c.auth.getSession()).data!.session!.user.email, "sdk@example.com");
    await c.auth.signOut();
  });

  it("resets a password, signs in with a magic link, and verifies a token directly", async () => {
    assert.equal((await c.auth.resetPasswordForEmail("sdk@example.com")).error, null);
    const recovered = await c.auth.getSessionFromUrl(await follow(link("sdk@example.com")));
    assert.equal(recovered.data!.type, "recovery");
    assert.equal((await c.auth.updateUser({ password: "brand-new-pass" })).error, null);
    await c.auth.signOut();
    assert.equal((await c.auth.signInWithPassword({ email: "sdk@example.com", password: "brand-new-pass" })).error, null);
    await c.auth.signOut();

    assert.equal((await c.auth.signInWithOtp({ email: "otp@example.com" })).error, null);
    const token = /token=([\w-]+)/.exec(mail.last("otp@example.com")!.text)![1]!;
    const v = await c.auth.verifyOtp({ type: "magiclink", token });
    assert.equal(v.error, null, JSON.stringify(v.error));
    assert.equal(v.data!.user.email, "otp@example.com");
    assert.equal((await c.auth.verifyOtp({ type: "magiclink", token })).error!.status, 403, "once only");
    assert.equal((await c.auth.signInWithOtp({ email: "ghost@example.com", options: { shouldCreateUser: false } })).error, null);
    assert.equal(mail.last("ghost@example.com"), undefined);
    assert.equal((await c.auth.resend({ type: "signup", email: "sdk@example.com" })).error, null);
  });

  it("signs in with the six-digit code from the email", async () => {
    assert.equal((await c.auth.signInWithOtp({ email: "codes@example.com" })).error, null);
    const code = /enter this code in the app: (\d{6})/.exec(mail.last("codes@example.com")!.text)![1]!;
    const bad = await c.auth.verifyOtp({ type: "email", email: "codes@example.com", token: code === "000000" ? "111111" : "000000" });
    assert.equal(bad.error!.status, 403);
    const ok = await c.auth.verifyOtp({ type: "email", email: "codes@example.com", token: code });
    assert.equal(ok.error, null, JSON.stringify(ok.error));
    assert.equal(ok.data!.user.email, "codes@example.com");
    assert.equal((await c.auth.getUser()).data!.user.email, "codes@example.com");
    await c.auth.signOut();
  });

  it("enrols an authenticator and upgrades the session with a code", async () => {
    const { codeFor, stepAt } = await import("./totp.js");
    assert.equal((await c.auth.signUp({ email: "mfa-sdk@example.com", password: "password-123" })).error, null);
    // (signed up before confirmation was required for this project? the earlier tests in this suite confirm by email, so confirm directly)
    await t.sql(owner, ref, "update auth.users set email_confirmed_at = now() where email = 'mfa-sdk@example.com'");
    assert.equal((await c.auth.signInWithPassword({ email: "mfa-sdk@example.com", password: "password-123" })).error, null);
    assert.deepEqual((await c.auth.mfa.getAuthenticatorAssuranceLevel()).data, { currentLevel: "aal1", nextLevel: "aal1" });
    const e = await c.auth.mfa.enroll({ friendlyName: "phone" });
    assert.equal(e.error, null, JSON.stringify(e.error));
    assert.deepEqual((await c.auth.mfa.listFactors()).data!.all, [], "not counted until verified");
    const bad = await c.auth.mfa.challengeAndVerify({ factorId: e.data!.id, code: "000000" === codeFor(e.data!.totp.secret, stepAt(Date.now())) ? "111111" : "000000" });
    assert.equal(bad.error!.code, "mfa_verification_failed");
    const ok = await c.auth.mfa.challengeAndVerify({ factorId: e.data!.id, code: codeFor(e.data!.totp.secret, stepAt(Date.now())) });
    assert.equal(ok.error, null, JSON.stringify(ok.error));
    assert.deepEqual((await c.auth.mfa.getAuthenticatorAssuranceLevel()).data, { currentLevel: "aal2", nextLevel: "aal2" });
    assert.equal((await c.auth.mfa.listFactors()).data!.all.length, 1);
    assert.equal((await c.auth.mfa.unenroll({ factorId: e.data!.id })).error, null);
    assert.equal((await c.auth.mfa.listFactors()).data!.all.length, 0);
    await c.auth.signOut();
  });

  it("builds the provider address and reads a failure from the URL", async () => {
    const r = await c.auth.signInWithOAuth({ provider: "github", options: { redirectTo: "https://app.example.com/cb", skipBrowserRedirect: true } });
    assert.equal(r.data!.url, `http://${ref}.localhost:${gwPort}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent("https://app.example.com/cb")}`);
    const bad = await c.auth.getSessionFromUrl("https://app.example.com/cb?error=access_denied#error=access_denied&error_code=access_denied&error_description=Nope");
    assert.deepEqual([bad.error!.code, bad.error!.message], ["access_denied", "Nope"]);
    assert.equal((await c.auth.getSessionFromUrl("https://app.example.com/cb")).error!.message, "no session in the URL");
  });
});
