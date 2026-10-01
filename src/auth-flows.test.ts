import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { redirectAllowed } from "./authsvc.js";
import { MemoryMailer, htmlFromText, renderTemplate } from "./mailer.js";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("small pieces", () => {
  it("allows redirects only to the site URL's origin or to listed addresses", () => {
    const s = { site_url: "https://app.example.com/home", redirect_urls: ["myapp://callback", "https://preview.example.com/*"] };
    for (const ok of ["https://app.example.com/anything?x=1", "myapp://callback", "https://preview.example.com/pr-1/auth"]) assert.equal(redirectAllowed(s, ok), true, ok);
    for (const bad of ["https://evil.com", "https://app.example.com.evil.com/", "http://app.example.com/", "myapp://other", "javascript:alert(1)", "https://user:pw@app.example.com/", "", null, 5, "https://preview.example.com.evil.com/x"]) assert.equal(redirectAllowed(s, bad), false, String(bad));
    assert.equal(redirectAllowed({}, "https://app.example.com"), false);
  });
  it("fills templates with only the known variables and escapes the HTML version", () => {
    assert.equal(renderTemplate("Hi {{ .Email }} {{.ConfirmationURL}} {{ .Secret }}", { Email: "a@b.co", ConfirmationURL: "http://x/y", SiteURL: "" }), "Hi a@b.co http://x/y ");
    const html = htmlFromText("Hello <script>alert(1)</script>\n\nOpen http://x/y?a=1&b=2 now");
    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<a href="http:\/\/x\/y\?a=1&amp;b=2">/);
  });
});

describe("email flows and sign-in with providers", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let strict: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  const mail = new MemoryMailer();
  let provider: http.Server;
  let base: string;
  // What the fake provider knows: code -> profile, and the last token request it saw.
  const profiles = new Map<string, any>();
  let tokenRequests: URLSearchParams[] = [];
  let tokenStatus = 200;

  const settings = async (ref = p.ref, body: unknown = {}) => {
    const r = await t.api("PATCH", `/v1/projects/${ref}/settings`, { token: owner, body });
    t.platform.dir.forget(ref); // the gateway caches project settings for a couple of seconds
    return r;
  };
  const gw = (method: string, url: string, o: { body?: unknown; headers?: Record<string, string>; key?: string } = {}) => t.gw(p.ref, method, url, { key: o.key ?? p.anon, body: o.body, headers: o.headers });
  const signup = (email: string, password = "password-123", q = "") => gw("POST", `/auth/v1/signup${q}`, { body: { email, password } });
  const login = (email: string, password = "password-123") => gw("POST", "/auth/v1/token?grant_type=password", { body: { email, password } });
  const tokenOf = (m: { text: string }) => /token=([\w-]+)&type=(\w+)/.exec(m.text)!;
  const hash = (loc: string) => new URLSearchParams(new URL(loc).hash.slice(1));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    provider = http.createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
        if (u.pathname === "/token") {
          const form = new URLSearchParams(Buffer.concat(chunks).toString());
          tokenRequests.push(form);
          if (tokenStatus !== 200) return send(tokenStatus, { error: "invalid_grant", error_description: "bad code" });
          if (form.get("client_id") !== "cid" || form.get("client_secret") !== "csecret" || !profiles.has(form.get("code")!)) return send(400, { error: "invalid_client" });
          return send(200, { access_token: `tok-${form.get("code")}` });
        }
        const code = /^Bearer tok-(.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
        const prof = code ? profiles.get(code) : undefined;
        if (!prof) return send(401, { error: "bad token" });
        if (u.pathname === "/user") return send(200, prof.user);
        if (u.pathname === "/emails") return send(200, prof.emails ?? []);
        send(404, {});
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    const over = { authUrl: `${base}/authorize`, tokenUrl: `${base}/token`, userUrl: `${base}/user`, emailsUrl: `${base}/emails` };
    t = await makePlatform(ADMIN!, { mail: { mailer: mail }, auth: { providerOverrides: { github: over, google: { ...over, emailsUrl: undefined } }, emailCooldownMs: 300 } });
    strict = await makePlatform(ADMIN!);
    owner = await t.org();
    p = await t.project(owner, "auth");
  });
  after(async () => {
    provider?.close();
    await t?.close();
    await strict?.close();
  });

  describe("email delivery switched off", () => {
    it("keeps the old behaviour: sign-ups are confirmed at once, email flows say they are unavailable, and confirmation cannot be required", async () => {
      const o = await strict.org();
      const sp = await strict.project(o, "plain");
      const g = (m: string, u: string, body?: unknown) => strict.gw(sp.ref, m, u, { key: sp.anon, body });
      assert.deepEqual((await g("GET", "/auth/v1/settings")).json.mailer_autoconfirm, true);
      assert.equal((await g("GET", "/auth/v1/settings")).json.email_delivery, false);
      const s = await g("POST", "/auth/v1/signup", { email: "a@example.com", password: "password-123" });
      assert.ok(s.json.access_token);
      for (const path of ["/recover", "/magiclink", "/otp"]) assert.equal((await g("POST", `/auth/v1${path}`, { email: "a@example.com" })).status, 501, path);
      const r = await strict.api("PATCH", `/v1/projects/${sp.ref}/settings`, { token: o, body: { email_confirm: true } });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /not configured/);
      const cfg = await strict.api("GET", `/v1/projects/${sp.ref}/auth-config`, { token: o });
      assert.equal(cfg.json.email_delivery, false);
    });
  });

  describe("confirming email addresses", () => {
    before(async () => {
      assert.equal((await settings(p.ref, { email_confirm: true, site_url: "https://app.example.com", redirect_urls: ["myapp://callback"], mailer_from_name: "Acme" })).status, 200);
    });

    it("signs up without a session, blocks sign-in until the link is used, then signs in once", async () => {
      assert.equal((await gw("GET", "/auth/v1/settings")).json.mailer_autoconfirm, false);
      const s = await signup("new@example.com");
      assert.equal(s.status, 200, s.text);
      assert.equal(s.json.access_token, undefined);
      assert.equal(s.json.email, "new@example.com");
      assert.equal(s.json.email_confirmed_at, null);
      const m = mail.last("new@example.com")!;
      assert.match(m.subject, /Confirm your email/);
      assert.equal(m.fromName, "Acme");
      assert.match(m.text, new RegExp(`http://${p.ref}\\.localhost:8081/auth/v1/verify\\?token=[\\w-]+&type=signup`));

      const early = await login("new@example.com");
      assert.equal(early.status, 400);
      assert.equal(early.json.error_code, "email_not_confirmed");

      const [, token] = tokenOf(m);
      const v = await gw("GET", `/auth/v1/verify?token=${token}&type=signup`);
      assert.equal(v.status, 302);
      const loc = v.headers.location as string;
      assert.match(loc, /^https:\/\/app\.example\.com\/#/);
      const f = hash(loc);
      assert.equal(f.get("type"), "signup");
      assert.equal((await gw("GET", "/auth/v1/user", { key: f.get("access_token")! })).json.email, "new@example.com");
      assert.equal((await login("new@example.com")).status, 200);

      const again = await gw("GET", `/auth/v1/verify?token=${token}&type=signup`);
      assert.equal(again.status, 403, "a link works once");
      assert.match(again.text, /already used|invalid/);
      assert.ok(!again.text.includes("<script"));
    });

    it("only follows redirects the owner allowed, and remembers the one chosen when the link was made", async () => {
      assert.equal((await signup("r1@example.com", "password-123", "?redirect_to=https://evil.example.net/x")).status, 400);
      assert.equal((await signup("r1@example.com", "password-123", "?redirect_to=javascript:alert(1)")).status, 400);
      const ok = await signup("r2@example.com", "password-123", "?redirect_to=myapp://callback");
      assert.equal(ok.status, 200, ok.text);
      const [, token] = tokenOf(mail.last("r2@example.com")!);
      const v = await gw("GET", `/auth/v1/verify?token=${token}&type=signup&redirect_to=https://evil.example.net`);
      assert.match(v.headers.location as string, /^myapp:\/\/callback#access_token=/, "a redirect_to added to the link is ignored");
    });

    it("sends a fresh link on request, retires the old one, and does not reveal who has an account", async () => {
      await signup("again@example.com");
      const first = tokenOf(mail.last("again@example.com")!)[1];
      await wait(350);
      const n = mail.outbox.length;
      assert.equal((await gw("POST", "/auth/v1/resend", { body: { type: "signup", email: "again@example.com" } })).status, 200);
      assert.equal(mail.outbox.length, n + 1);
      const second = tokenOf(mail.last("again@example.com")!)[1];
      assert.notEqual(first, second);
      assert.equal((await gw("GET", `/auth/v1/verify?token=${first}&type=signup`)).status, 403, "only the newest link works");
      assert.equal((await gw("GET", `/auth/v1/verify?token=${second}&type=signup`)).status, 302);
      await wait(350);
      const m = mail.outbox.length;
      assert.equal((await gw("POST", "/auth/v1/resend", { body: { type: "signup", email: "again@example.com" } })).status, 200, "confirmed already");
      assert.equal((await gw("POST", "/auth/v1/resend", { body: { type: "signup", email: "nobody@example.com" } })).status, 200, "unknown address");
      assert.equal(mail.outbox.length, m, "nothing was sent to either");
      assert.equal((await gw("POST", "/auth/v1/resend", { body: { type: "email_change", email: "again@example.com" } })).status, 422);
      assert.equal((await gw("POST", "/auth/v1/resend", { body: { type: "signup", email: "not an email" } })).status, 422);
    });

    it("limits how often one address can be emailed", async () => {
      await signup("limit@example.com");
      const r = await gw("POST", "/auth/v1/recover", { body: { email: "limit@example.com" } });
      assert.equal(r.status, 200);
      const again = await gw("POST", "/auth/v1/recover", { body: { email: "limit@example.com" } });
      assert.equal(again.status, 429);
      assert.equal(again.json.error_code, "over_email_send_rate_limit");
      assert.equal((await gw("POST", "/auth/v1/recover", { body: { email: "ghost@example.com" } })).status, 200);
      assert.equal((await gw("POST", "/auth/v1/recover", { body: { email: "ghost@example.com" } })).status, 429, "unknown addresses are limited too, so the limit reveals nothing");
    });

    it("rejects an expired link", async () => {
      await signup("slow@example.com");
      const [, token] = tokenOf(mail.last("slow@example.com")!);
      await t.sql(owner, p.ref, "update auth.one_time_tokens set expires_at = now() - interval '1 minute'");
      assert.equal((await gw("GET", `/auth/v1/verify?token=${token}&type=signup`)).status, 403);
      assert.equal((await login("slow@example.com")).json.error_code, "email_not_confirmed");
    });

    it("uses the owner's templates and escapes them in the HTML version", async () => {
      await settings(p.ref, { email_templates: { confirmation: { subject: "Welcome to Acme", body: "Hi {{ .Email }} <b>friend</b>,\n\nClick {{ .ConfirmationURL }} on {{ .SiteURL }}" } } });
      await signup("tpl@example.com");
      const m = mail.last("tpl@example.com")!;
      assert.equal(m.subject, "Welcome to Acme");
      assert.match(m.text, /^Hi tpl@example\.com <b>friend<\/b>,\n\nClick http:\/\/.*\/auth\/v1\/verify\?token=.* on https:\/\/app\.example\.com$/);
      assert.ok(!m.html!.includes("<b>friend"));
      assert.match(m.html!, /&lt;b&gt;friend&lt;\/b&gt;/);
      const bad = await settings(p.ref, { email_templates: { confirmation: { subject: "line\nbreak" } } });
      assert.equal(bad.status, 400);
      assert.equal((await settings(p.ref, { email_templates: { evil: { subject: "x" } } })).status, 400);
    });

    it("enforces the minimum password length the owner chose", async () => {
      assert.equal((await settings(p.ref, { password_min_length: 12 })).status, 200);
      const s = await signup("short@example.com", "password-1");
      assert.equal(s.status, 422);
      assert.equal(s.json.error_code, "weak_password");
      assert.match(s.json.msg, /at least 12/);
      assert.equal((await signup("long@example.com", "a-long-enough-password")).status, 200);
      assert.equal((await settings(p.ref, { password_min_length: 3 })).status, 400);
      await settings(p.ref, { password_min_length: 6 });
    });

    it("does not let a signed-in user confirm themselves, ban themselves, or edit app metadata, and re-confirms a changed address", async () => {
      await settings(p.ref, { email_confirm: false });
      const s = await signup("self@example.com");
      const key = s.json.access_token as string;
      const put = (body: unknown) => gw("PUT", "/auth/v1/user", { key, body });
      const before = (await gw("GET", "/auth/v1/user", { key })).json;
      const r = await put({ app_metadata: { role: "admin" }, ban_duration: "876000h", email_confirm: true, data: { nick: "ok" } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.app_metadata, before.app_metadata, "app_metadata is for administrators");
      assert.equal(r.json.banned_until, null);
      assert.equal(r.json.user_metadata.nick, "ok");

      await settings(p.ref, { email_confirm: true });
      await wait(350);
      const n = mail.outbox.length;
      const c = await put({ email: "moved@example.com" });
      assert.equal(c.status, 200, c.text);
      assert.equal(c.json.email_confirmed_at, null);
      assert.equal(mail.outbox.length, n + 1);
      assert.equal(mail.last()!.to, "moved@example.com");
      assert.equal((await login("moved@example.com")).json.error_code, "email_not_confirmed");
      const [, token] = tokenOf(mail.last()!);
      assert.equal((await gw("GET", `/auth/v1/verify?token=${token}&type=signup`)).status, 302);
      assert.equal((await login("moved@example.com")).status, 200);
    });

    it("lets an administrator create users confirmed by default, or unconfirmed on request", async () => {
      const svc = p.service;
      const a = await gw("POST", "/auth/v1/admin/users", { key: svc, body: { email: "adm1@example.com", password: "password-123" } });
      assert.ok(a.json.email_confirmed_at);
      assert.equal((await login("adm1@example.com")).status, 200);
      const b = await gw("POST", "/auth/v1/admin/users", { key: svc, body: { email: "adm2@example.com", password: "password-123", email_confirm: false } });
      assert.equal(b.json.email_confirmed_at, null);
      assert.equal((await login("adm2@example.com")).json.error_code, "email_not_confirmed");
      const c = await gw("PUT", `/auth/v1/admin/users/${b.json.id}`, { key: svc, body: { email_confirm: true } });
      assert.ok(c.json.email_confirmed_at);
      assert.equal((await login("adm2@example.com")).status, 200);
    });
  });

  describe("password recovery and magic links", () => {
    it("resets a password through an emailed link", async () => {
      await settings(p.ref, { email_confirm: false });
      await signup("reset@example.com", "old-password-1");
      await wait(350);
      assert.equal((await gw("POST", "/auth/v1/recover", { body: { email: "reset@example.com" } })).status, 200);
      const m = mail.last("reset@example.com")!;
      assert.match(m.subject, /Reset your password/);
      const [, token, type] = tokenOf(m) as unknown as [string, string, string];
      assert.equal(type, "recovery");
      const v = await gw("GET", `/auth/v1/verify?token=${token}&type=recovery`);
      assert.equal(v.status, 302);
      const f = hash(v.headers.location as string);
      assert.equal(f.get("type"), "recovery");
      const set = await gw("PUT", "/auth/v1/user", { key: f.get("access_token")!, body: { password: "new-password-1" } });
      assert.equal(set.status, 200, set.text);
      assert.equal((await login("reset@example.com", "old-password-1")).status, 400);
      assert.equal((await login("reset@example.com", "new-password-1")).status, 200);
      assert.equal((await gw("GET", `/auth/v1/verify?token=${token}&type=recovery`)).status, 403);
    });

    it("answers the same for unknown addresses and sends nothing", async () => {
      await wait(350);
      const n = mail.outbox.length;
      const r = await gw("POST", "/auth/v1/recover", { body: { email: "who@example.com" } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, {});
      assert.equal(mail.outbox.length, n);
    });

    it("signs in with a magic link, creating the account on first use unless told not to", async () => {
      await wait(350);
      assert.equal((await gw("POST", "/auth/v1/magiclink", { body: { email: "magic@example.com" } })).status, 200);
      const m = mail.last("magic@example.com")!;
      assert.match(m.subject, /sign-in link/);
      const [, token, type] = tokenOf(m) as unknown as [string, string, string];
      assert.equal(type, "magiclink");
      const v = await gw("POST", "/auth/v1/verify", { body: { type: "magiclink", token } });
      assert.equal(v.status, 200, v.text);
      assert.equal(v.json.user.email, "magic@example.com");
      assert.ok(v.json.user.email_confirmed_at, "following the link proves the address");
      assert.equal((await login("magic@example.com", "anything")).status, 400, "no password was set");

      const n = mail.outbox.length;
      await wait(350);
      assert.equal((await gw("POST", "/auth/v1/otp", { body: { email: "unknown@example.com", create_user: false } })).status, 200);
      assert.equal(mail.outbox.length, n, "create_user false: no account and no email");
      await settings(p.ref, { disable_signup: true });
      await wait(350);
      assert.equal((await gw("POST", "/auth/v1/magiclink", { body: { email: "blocked@example.com" } })).status, 200);
      assert.equal(mail.outbox.length, n, "sign-ups off: no account and no email");
      assert.equal((await t.sql(owner, p.ref, "select count(*)::int from auth.users where email = 'blocked@example.com'")).json.results[0].rows[0][0], 0);
      await settings(p.ref, { disable_signup: false });
    });

    it("refuses a token of the wrong kind, a malformed token and a made-up one", async () => {
      await wait(350);
      await gw("POST", "/auth/v1/magiclink", { body: { email: "kind@example.com" } });
      const [, token] = tokenOf(mail.last("kind@example.com")!);
      assert.equal((await gw("POST", "/auth/v1/verify", { body: { type: "recovery", token } })).status, 403);
      assert.equal((await gw("POST", "/auth/v1/verify", { body: { type: "bogus", token } })).status, 422);
      assert.equal((await gw("POST", "/auth/v1/verify", { body: { type: "magiclink", token: "short" } })).status, 403);
      assert.equal((await gw("POST", "/auth/v1/verify", { body: { type: "magiclink", token: "x".repeat(43) } })).status, 403);
      assert.equal((await gw("POST", "/auth/v1/verify", { body: { type: "magiclink", token } })).status, 200, "the right kind still works afterwards");
    });
  });

  describe("signing in with a provider", () => {
    const github = (id: string, email: string | null, o: { verified?: boolean; name?: string } = {}) => ({
      user: { id, login: `user${id}`, name: o.name ?? `User ${id}`, avatar_url: `https://img.example/${id}.png` },
      emails: email ? [{ email, primary: true, verified: o.verified !== false }] : [],
    });
    const start = async (name = "github", redirect = "https://app.example.com/cb") => {
      const r = await gw("GET", `/auth/v1/authorize?provider=${name}&redirect_to=${encodeURIComponent(redirect)}`);
      const cookie = /baas_oauth=([\w-]+)/.exec(String(r.headers["set-cookie"] ?? ""))?.[1];
      return { r, cookie, url: r.headers.location ? new URL(r.headers.location as string) : null };
    };
    const finish = async (code: string, flow: Awaited<ReturnType<typeof start>>, o: { cookie?: string | null; state?: string } = {}) =>
      gw("GET", `/auth/v1/callback?code=${code}&state=${encodeURIComponent(o.state ?? flow.url!.searchParams.get("state")!)}`, { headers: o.cookie === null ? {} : { cookie: `baas_oauth=${o.cookie ?? flow.cookie}` } });

    before(async () => {
      await settings(p.ref, { email_confirm: false, site_url: "https://app.example.com", redirect_urls: ["myapp://callback"] });
    });

    it("keeps the client secret out of every response and needs both credentials before a provider can be enabled", async () => {
      assert.equal((await settings(p.ref, { auth_providers: { github: { enabled: true } } })).status, 400);
      assert.equal((await settings(p.ref, { auth_providers: { github: { enabled: true, client_id: "cid" } } })).status, 400);
      assert.equal((await settings(p.ref, { auth_providers: { nope: { enabled: true } } })).status, 400);
      assert.equal((await settings(p.ref, { auth_providers: { github: { secret: 5 } } })).status, 400);
      const ok = await settings(p.ref, { auth_providers: { github: { enabled: true, client_id: "cid", secret: "csecret" }, google: { client_id: "cid", secret: "csecret" } } });
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(ok.json.auth_providers.github, { enabled: true, client_id: "cid", secret_set: true });
      for (const r of [ok, await t.api("GET", `/v1/projects/${p.ref}/settings`, { token: owner }), await t.api("GET", `/v1/projects/${p.ref}/auth-config`, { token: owner })]) {
        assert.ok(!r.text.includes("csecret"), "the secret is never returned");
        assert.ok(!r.text.includes("secret_enc"));
      }
      const cfg = (await t.api("GET", `/v1/projects/${p.ref}/auth-config`, { token: owner })).json;
      assert.equal(cfg.callback_url, `http://${p.ref}.localhost:8081/auth/v1/callback`);
      assert.deepEqual(cfg.providers.map((x: any) => [x.id, x.enabled, x.secret_set]).filter((x: any) => ["github", "google", "gitlab"].includes(x[0])).sort(), [["github", true, true], ["gitlab", false, false], ["google", false, true]]);
      assert.ok(cfg.templates.recovery.subject);
      // The sealed secret is what is stored, and it is bound to this project and provider.
      const raw = (await t.platform.pool.query(`SELECT settings -> 'auth_providers' -> 'github' ->> 'secret_enc' AS e FROM project_settings WHERE ref = $1`, [p.ref])).rows[0].e as string;
      assert.match(raw, /^v1\./);
      const ext = (await gw("GET", "/auth/v1/settings")).json.external;
      assert.deepEqual([ext.github, ext.google, ext.email], [true, false, true], "a provider with no enabled switch is off");
      // Clearing the secret switches it off in effect.
      assert.equal((await settings(p.ref, { auth_providers: { google: { secret: "" } } })).json.auth_providers.google.secret_set, false);
    });

    it("sends the browser to the provider with a state bound to this browser, and rejects bad requests", async () => {
      const f = await start();
      assert.equal(f.r.status, 302);
      assert.equal(f.url!.origin + f.url!.pathname, `${base}/authorize`);
      assert.equal(f.url!.searchParams.get("client_id"), "cid");
      assert.equal(f.url!.searchParams.get("redirect_uri"), `http://${p.ref}.localhost:8081/auth/v1/callback`);
      assert.equal(f.url!.searchParams.get("response_type"), "code");
      assert.match(f.url!.searchParams.get("scope")!, /user:email/);
      assert.ok(!f.url!.search.includes("csecret"));
      assert.equal(f.url!.searchParams.get("code_challenge"), null, "GitHub does not get PKCE");
      assert.match(String(f.r.headers["set-cookie"]), /baas_oauth=[\w-]+; HttpOnly; SameSite=Lax; Path=\/auth\/v1; Max-Age=600/);
      assert.equal((await gw("GET", "/auth/v1/authorize?provider=github&redirect_to=https://evil.example.net")).status, 400);
      assert.equal((await gw("GET", "/auth/v1/authorize?provider=gitlab&redirect_to=https://app.example.com/")).status, 400, "not enabled");
      assert.equal((await gw("GET", "/auth/v1/authorize?provider=nope&redirect_to=https://app.example.com/")).status, 400);
      assert.equal((await gw("GET", "/auth/v1/authorize?redirect_to=https://app.example.com/")).status, 400);
    });

    it("creates the user, links the identity, and sends the session back in the fragment", async () => {
      profiles.set("c1", github("101", "octo@example.com", { name: "Octo Cat" }));
      const f = await start();
      const done = await finish("c1", f);
      assert.equal(done.status, 302, done.text);
      const loc = done.headers.location as string;
      assert.match(loc, /^https:\/\/app\.example\.com\/cb#/);
      const tokens = hash(loc);
      assert.equal(tokens.get("type"), "oauth");
      const me = (await gw("GET", "/auth/v1/user", { key: tokens.get("access_token")! })).json;
      assert.equal(me.email, "octo@example.com");
      assert.ok(me.email_confirmed_at, "the provider vouched for the address");
      assert.equal(me.app_metadata.provider, "github");
      assert.equal(me.user_metadata.full_name, "Octo Cat");
      assert.equal(me.user_metadata.avatar_url, "https://img.example/101.png");
      const treq = tokenRequests.at(-1)!;
      assert.equal(treq.get("client_secret"), "csecret");
      assert.equal(treq.get("redirect_uri"), `http://${p.ref}.localhost:8081/auth/v1/callback`);
      assert.equal(treq.get("code_verifier"), null);
      assert.match(String(done.headers["set-cookie"]), /baas_oauth=;.*Max-Age=0/, "the cookie is cleared");

      const f2 = await start();
      const again = await finish("c1", f2);
      assert.equal((await gw("GET", "/auth/v1/user", { key: hash(again.headers.location as string).get("access_token")! })).json.id, me.id, "the same identity is the same user");
      const ids = (await t.sql(owner, p.ref, "select count(*)::int from auth.identities where provider = 'github'")).json.results[0].rows[0][0];
      assert.equal(ids, 1);
    });

    it("refuses a callback that was not started in this browser, was tampered with, or belongs to another project", async () => {
      profiles.set("c2", github("102", "two@example.com"));
      const f = await start();
      const noCookie = await finish("c2", f, { cookie: null });
      assert.equal(noCookie.status, 302);
      assert.match(noCookie.headers.location as string, /^https:\/\/app\.example\.com\/cb\?error=bad_oauth_callback/);
      assert.match(hash(noCookie.headers.location as string).get("error_description")!, /not started in this browser/);
      assert.equal((await finish("c2", f, { cookie: "someone-elses-nonce" })).status, 302);
      const [payload, sig] = f.url!.searchParams.get("state")!.split(".");
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), r: "https://evil.example.net/" })).toString("base64url");
      const t1 = await finish("c2", f, { state: `${forged}.${sig}` });
      assert.equal(t1.status, 400, "a changed state is not trusted, and not redirected to");
      assert.equal(t1.headers.location, undefined);
      assert.equal((await finish("c2", f, { state: "garbage" })).status, 400);
      assert.equal((await t.sql(owner, p.ref, "select count(*)::int from auth.users where email = 'two@example.com'")).json.results[0].rows[0][0], 0);

      const o2 = await t.org();
      const other = await t.project(o2, "other");
      await t.api("PATCH", `/v1/projects/${other.ref}/settings`, { token: o2, body: { site_url: "https://app.example.com", auth_providers: { github: { enabled: true, client_id: "cid", secret: "csecret" } } } });
      t.platform.dir.forget(other.ref);
      const cross = await t.gw(other.ref, "GET", `/auth/v1/callback?code=c2&state=${encodeURIComponent(f.url!.searchParams.get("state")!)}`, { headers: { cookie: `baas_oauth=${f.cookie}` } });
      assert.equal(cross.status, 400, "a state signed by another project is rejected");
    });

    it("links to an existing account only when the provider verified the address", async () => {
      await signup("ann@example.com", "password-123");
      const annId = (await login("ann@example.com")).json.user.id;
      await settings(p.ref, { auth_providers: { google: { enabled: true, client_id: "cid", secret: "csecret" } } });
      profiles.set("c3", { user: { sub: "g-103", email: "ann@example.com", email_verified: false, name: "Not Ann" } });
      const bad = await finish("c3", await start("google"));
      assert.match(bad.headers.location as string, /error=email_exists/);
      assert.equal((await t.sql(owner, p.ref, "select count(*)::int from auth.identities where provider_id = 'g-103'")).json.results[0].rows[0][0], 0);
      // GitHub never reports an address it has not verified, so such a user simply has no email and cannot take over anything.
      profiles.set("c3b", github("1030", "ann@example.com", { verified: false }));
      const noEmail = await finish("c3b", await start());
      assert.equal((await gw("GET", "/auth/v1/user", { key: hash(noEmail.headers.location as string).get("access_token")! })).json.email, null);

      profiles.set("c4", github("104", "ann@example.com", { verified: true }));
      const good = await finish("c4", await start());
      assert.equal((await gw("GET", "/auth/v1/user", { key: hash(good.headers.location as string).get("access_token")! })).json.id, annId);
      assert.equal((await login("ann@example.com")).status, 200, "the password still works");
      const providers = (await t.sql(owner, p.ref, `select raw_app_meta_data -> 'providers' from auth.users where id = '${annId}'`)).json.results[0].rows[0][0];
      assert.deepEqual([...providers].sort(), ["github"]);
    });

    it("takes the password away from an address that was registered but never confirmed, once the provider proves ownership", async () => {
      await settings(p.ref, { email_confirm: true });
      await signup("victim@example.com", "attacker-chosen-1");
      assert.equal((await login("victim@example.com", "attacker-chosen-1")).json.error_code, "email_not_confirmed");
      await settings(p.ref, { email_confirm: false });
      profiles.set("c5", github("105", "victim@example.com", { verified: true }));
      const done = await finish("c5", await start());
      assert.equal(done.status, 302);
      assert.equal((await login("victim@example.com", "attacker-chosen-1")).status, 400, "the squatter's password no longer works");
      assert.ok((await gw("GET", "/auth/v1/user", { key: hash(done.headers.location as string).get("access_token")! })).json.email_confirmed_at);
    });

    it("respects sign-up and ban settings, and reports provider failures without leaking details", async () => {
      await settings(p.ref, { disable_signup: true });
      profiles.set("c6", github("106", "new6@example.com"));
      assert.match((await finish("c6", await start())).headers.location as string, /error=signup_disabled/);
      await settings(p.ref, { disable_signup: false });

      const octo = (await t.sql(owner, p.ref, "select id from auth.users where email = 'octo@example.com'")).json.results[0].rows[0][0];
      await t.sql(owner, p.ref, `update auth.users set banned_until = now() + interval '1 day' where id = '${octo}'`);
      assert.match((await finish("c1", await start())).headers.location as string, /error=user_banned/);
      await t.sql(owner, p.ref, `update auth.users set banned_until = null where id = '${octo}'`);

      assert.match((await finish("unknown-code", await start())).headers.location as string, /error=provider_error/);
      tokenStatus = 400;
      const down = await finish("c1", await start());
      tokenStatus = 200;
      assert.match(hash(down.headers.location as string).get("error_description")!, /answered 400: bad code/);
      const denied = await gw("GET", `/auth/v1/callback?error=access_denied&error_description=${encodeURIComponent("The user said no")}&state=${encodeURIComponent((await start().then((f) => (f.url!.searchParams.get("state")!))))}`, { headers: { cookie: "baas_oauth=x" } });
      assert.equal(denied.status, 302);
    });

    it("adds PKCE for providers that support it", async () => {
      profiles.set("g1", { user: { sub: "g-1", email: "gee@example.com", email_verified: true, name: "Gee", picture: "https://img.example/g.png" } });
      const f = await start("google");
      assert.equal(f.url!.searchParams.get("code_challenge_method"), "S256");
      const challenge = f.url!.searchParams.get("code_challenge")!;
      const done = await finish("g1", f);
      assert.equal(done.status, 302, done.text);
      const verifier = tokenRequests.at(-1)!.get("code_verifier")!;
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge, "the verifier matches the challenge sent first");
      assert.equal((await gw("GET", "/auth/v1/user", { key: hash(done.headers.location as string).get("access_token")! })).json.email, "gee@example.com");
    });

    it("works with a custom-scheme redirect the owner listed", async () => {
      profiles.set("c7", github("107", "app7@example.com"));
      const f = await start("github", "myapp://callback");
      const done = await finish("c7", f);
      assert.match(done.headers.location as string, /^myapp:\/\/callback#access_token=/);
    });
  });

  describe("projects that predate these tables", () => {
    it("gets them the first time they are needed", async () => {
      const old = await t.project(owner, "legacy");
      const c = new pg.Client({ connectionString: old.dbUrl });
      await c.connect();
      await c.query("DROP TABLE auth.one_time_tokens, auth.identities");
      await c.end();
      await t.api("PATCH", `/v1/projects/${old.ref}/settings`, { token: owner, body: { email_confirm: true, site_url: "https://app.example.com" } });
      t.platform.dir.forget(old.ref);
      const s = await t.gw(old.ref, "POST", "/auth/v1/signup", { key: old.anon, body: { email: "legacy@example.com", password: "password-123" } });
      assert.equal(s.status, 200, s.text);
      const m = mail.last("legacy@example.com")!;
      const [, token] = tokenOf(m);
      assert.equal((await t.gw(old.ref, "GET", `/auth/v1/verify?token=${token}&type=signup`)).status, 302);
    });
  });
});
