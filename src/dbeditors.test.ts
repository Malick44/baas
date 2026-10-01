import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("policy test endpoint", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string, dev: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  let ann: string, bob: string;
  const test = (body: unknown, token = owner) => t.api("POST", `/v1/projects/${p.ref}/policy-test`, { token, body });

  before(async () => {
    t = await makePlatform(ADMIN!);
    owner = await t.org();
    dev = await t.token(owner, "developer");
    p = await t.project(owner, "main");
    const signup = async (email: string) => (await t.gw(p.ref, "POST", "/auth/v1/signup", { key: p.anon, body: { email, password: "password-123" } })).json.user.id as string;
    ann = await signup("ann@example.com");
    bob = await signup("bob@example.com");
    await t.sql(owner, p.ref, `
      create table public.docs (id serial primary key, owner uuid, title text);
      grant select on public.docs to anon, authenticated;
      alter table public.docs enable row level security;
      create policy "public titles" on public.docs for select to anon using (title like 'public%');
      create policy "own rows" on public.docs for select to authenticated using (owner = auth.uid());
      insert into public.docs (owner, title) values ('${ann}', 'ann private'), ('${ann}', 'public from ann'), ('${bob}', 'bob private');
      create table public.secret (id serial primary key); insert into public.secret default values;`);
  });
  after(() => t?.close());

  it("shows what an anonymous visitor and each user can see, against the real total", async () => {
    const anon = await test({ table: "docs", as: { type: "anon" } });
    assert.equal(anon.status, 200, anon.text);
    assert.deepEqual([anon.json.visible, anon.json.total, anon.json.allowed, anon.json.rls, anon.json.policies], [1, 3, true, true, 2]);
    assert.equal(anon.json.sample[0].title, "public from ann");
    const a = await test({ table: "docs", as: { type: "user", userId: ann } });
    assert.equal(a.json.visible, 2);
    assert.match(a.json.identity, /ann@example\.com/);
    assert.deepEqual(a.json.sample.map((r: any) => r.title).sort(), ["ann private", "public from ann"]);
    assert.equal((await test({ table: "docs", as: { type: "user", userId: bob } })).json.visible, 1);
    assert.equal((await test({ table: "docs" })).json.visible, 1, "anonymous by default");
  });

  it("reports a missing grant instead of failing, and with RLS off everything is visible", async () => {
    const r = await test({ table: "secret", as: { type: "anon" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.allowed, false);
    assert.match(r.json.reason, /no access to this table/);
    assert.equal(r.json.total, 1);
    await t.sql(owner, p.ref, "grant select on public.secret to anon");
    const open = await test({ table: "secret", as: { type: "anon" } });
    assert.deepEqual([open.json.allowed, open.json.rls, open.json.visible], [true, false, 1]);
  });

  it("validates input and needs the admin role", async () => {
    assert.equal((await test({ table: "docs; drop table docs", as: { type: "anon" } })).status, 400);
    assert.equal((await test({ as: { type: "anon" } })).status, 400);
    assert.equal((await test({ table: "nope", as: { type: "anon" } })).status, 404);
    assert.equal((await test({ table: "docs", as: { type: "root" } })).status, 400);
    assert.equal((await test({ table: "docs", as: { type: "user" } })).status, 400);
    assert.equal((await test({ table: "docs", as: { type: "user", userId: "00000000-0000-0000-0000-000000000000" } })).status, 404);
    assert.equal((await test({ table: "docs", as: { type: "anon" } }, dev)).status, 403);
    const other = await t.org();
    assert.equal((await test({ table: "docs", as: { type: "anon" } }, other)).status, 404);
  });
});
