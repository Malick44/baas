import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { originMatches } from "./gateway.js";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("origin patterns", () => {
  it("match exactly, by subdomain wildcard, or everything", () => {
    assert.equal(originMatches("https://app.example.com", "https://app.example.com"), true);
    assert.equal(originMatches("https://APP.example.com", "https://app.EXAMPLE.com"), true, "case-insensitive");
    assert.equal(originMatches("*", "https://anything.net"), true);
    assert.equal(originMatches("https://*.example.com", "https://a.example.com"), true);
    assert.equal(originMatches("https://*.example.com", "https://a.b.example.com"), true);
    assert.equal(originMatches("http://*.localhost:3000", "http://x.localhost:3000"), true);
    for (const [p, o] of [
      ["https://app.example.com", "http://app.example.com"], ["https://app.example.com", "https://app.example.com:8443"], ["https://app.example.com", "https://app.example.com.evil.com"],
      ["https://*.example.com", "https://example.com"], ["https://*.example.com", "https://evil.com/.example.com"], ["https://*.example.com", "https://evil-example.com"],
      ["https://*.example.com", "https://a.example.com.evil.com"], ["https://*.example.com", "http://a.example.com"], ["https://*.example.com", "https://.example.com"],
      ["https://*", "https://a.com"], ["*.example.com", "https://a.example.com"], ["https://a*.example.com", "https://ab.example.com"], ["", "https://a.com"], ["null", "https://a.com"],
    ] as const) assert.equal(originMatches(p, o), false, `${p} vs ${o}`);
  });
});

describe("cors per project", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  const setCors = async (list: unknown) => {
    const r = await t.api("PATCH", `/v1/projects/${p.ref}/settings`, { token: owner, body: { cors_origins: list } });
    t.platform.dir.forget(p.ref);
    return r;
  };
  const get = (origin: string | undefined, path = "/rest/v1/", method = "GET", extra: Record<string, string> = {}) =>
    t.gw(p.ref, method, path, { key: p.anon, headers: { ...(origin ? { origin } : {}), ...extra } });
  const allowed = (r: { headers: Record<string, any> }) => r.headers["access-control-allow-origin"];

  before(async () => {
    t = await makePlatform(ADMIN!, { dashboardOrigins: ["http://dash.test:8080"] });
    owner = await t.org();
    p = await t.project(owner, "cors");
  });
  after(() => t?.close());

  it("allows any origin until the owner lists some", async () => {
    assert.equal(allowed(await get("https://anywhere.example")), "*");
    assert.equal(allowed(await get(undefined)), "*");
  });

  it("then grants the permission only to listed origins, and tells caches it varies", async () => {
    assert.equal((await setCors(["https://app.example.com", "https://*.preview.example.com"])).status, 200);
    const ok = await get("https://app.example.com");
    assert.equal(allowed(ok), "https://app.example.com");
    assert.match(String(ok.headers.vary), /Origin/);
    assert.equal(allowed(await get("https://x.preview.example.com")), "https://x.preview.example.com");
    for (const bad of ["https://evil.example", "https://app.example.com.evil.net", "http://app.example.com", "null", ""]) {
      const r = await get(bad);
      assert.equal(allowed(r), undefined, `"${bad}" is not granted`);
      assert.match(String(r.headers.vary), /Origin/);
    }
    assert.equal(allowed(await get(undefined)), undefined, "no Origin header: nothing to grant");
  });

  it("applies to preflight, to errors, and to every service", async () => {
    const pre = await t.gw(p.ref, "OPTIONS", "/rest/v1/todos", { headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(allowed(pre), "https://app.example.com");
    assert.match(String(pre.headers["access-control-allow-headers"]), /authorization/);
    const badPre = await t.gw(p.ref, "OPTIONS", "/rest/v1/todos", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(badPre.status, 204);
    assert.equal(allowed(badPre), undefined, "a disallowed origin's preflight is not granted, so the browser blocks the real request");
    const err = await t.gw(p.ref, "GET", "/rest/v1/nope", { headers: { origin: "https://app.example.com" } }); // no key: 401
    assert.equal(err.status, 401);
    assert.equal(allowed(err), "https://app.example.com", "an error is readable by an allowed origin");
    const errBad = await t.gw(p.ref, "GET", "/rest/v1/nope", { headers: { origin: "https://evil.example" } });
    assert.equal(allowed(errBad), undefined);
    for (const path of ["/auth/v1/settings", "/storage/v1/bucket", "/functions/v1/x"]) assert.equal(allowed(await get("https://app.example.com", path)), "https://app.example.com", path);
    // Requests are still answered: this protects browsers, not servers.
    assert.equal((await get("https://evil.example", "/auth/v1/settings")).status, 200);
  });

  it("always lets the dashboard through, so a restrictive list cannot lock the owner out", async () => {
    assert.equal(allowed(await get("http://dash.test:8080")), "http://dash.test:8080");
    assert.equal(allowed(await get("http://dash.test:9999")), undefined, "only the configured dashboard origins");
  });

  it("stays per project, and clearing the list opens it again", async () => {
    const o2 = await t.org();
    const other = await t.project(o2, "other");
    const r = await t.gw(other.ref, "GET", "/rest/v1/", { key: other.anon, headers: { origin: "https://evil.example" } });
    assert.equal(allowed(r), "*", "another project's list does not apply");
    assert.equal((await setCors([])).status, 200);
    assert.equal(allowed(await get("https://evil.example")), "*");
  });

  it("validates the setting", async () => {
    assert.equal((await setCors("https://a.com")).status, 400);
    assert.equal((await setCors([1, 2])).status, 400);
    assert.equal((await setCors(["https://a.com"])).status, 200);
    await setCors([]);
  });
});
