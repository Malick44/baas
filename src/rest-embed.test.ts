import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseSelectTree } from "./rest-embed.js";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("select parsing", () => {
  it("separates columns from embeds, with aliases, hints and nesting", () => {
    const t = parseSelectTree("id,name,total:amount,orders!inner(id,items(*)),buyer:customers!fk_customer(name)");
    assert.deepEqual(t.columns, ['"id"', '"name"', '"amount" AS "total"']);
    assert.deepEqual(t.embeds.map((e) => [e.alias, e.name, e.hint, e.inner]), [["orders", "orders", null, true], ["buyer", "customers", "fk_customer", false]]);
    assert.deepEqual(t.embeds[0]!.embeds.map((e) => e.name), ["items"]);
    assert.deepEqual(parseSelectTree(undefined), { columns: ["*"], embeds: [] });
    assert.deepEqual(parseSelectTree("orders(*)").columns, [], "only the embed was asked for");
  });
  it("refuses what it does not support, clearly", () => {
    for (const bad of ["orders(", "orders)", "...orders(*)", "a(b(c(d(*))))", "1bad(*)", "orders!(*)", "orders!a!b!c(*)", "orders(*),orders(id)", "x::int", "data->a", "orders!evil;x(*)"])
      assert.throws(() => parseSelectTree(bad), (e: any) => e.status === 400, bad);
    assert.throws(() => parseSelectTree(Array.from({ length: 11 }, (_, i) => `t${i}(*)`).join(",")), /at most 10/);
  });
});

describe("embedded resources over HTTP", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  let ann: { token: string; id: string };
  let bob: { token: string; id: string };

  const get = (path: string, key = p.anon, headers: Record<string, string> = {}) => t.gw(p.ref, "GET", `/rest/v1/${path}`, { key, headers });
  const signup = async (email: string) => { const s = (await t.gw(p.ref, "POST", "/auth/v1/signup", { key: p.anon, body: { email, password: "password-123" } })).json; return { token: s.access_token as string, id: s.user.id as string }; };

  before(async () => {
    t = await makePlatform(ADMIN!);
    owner = await t.org();
    p = await t.project(owner, "embed");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
    ann = await signup("ann@example.com");
    bob = await signup("bob@example.com");
    await t.sql(owner, p.ref, `
      create table public.customers (id serial primary key, name text not null, owner uuid);
      create table public.orders (id serial primary key, customer_id int not null references public.customers, status text not null, total int not null);
      create table public.items (id serial primary key, order_id int not null references public.orders, sku text not null, qty int not null);
      create table public.transfers (id serial primary key, from_customer int references public.customers, to_customer int references public.customers, amount int);
      create table public.nodes (id serial primary key, parent_id int references public.nodes, label text);
      insert into public.customers (name, owner) values ('Acme', '${ann.id}'), ('Globex', '${bob.id}'), ('Empty Co', '${ann.id}');
      insert into public.orders (customer_id, status, total) values (1, 'paid', 100), (1, 'open', 50), (1, 'paid', 300), (2, 'paid', 70);
      insert into public.items (order_id, sku, qty) values (1, 'a', 1), (1, 'b', 2), (3, 'c', 5), (4, 'd', 1);
      insert into public.transfers (from_customer, to_customer, amount) values (1, 2, 10);
      insert into public.nodes (parent_id, label) values (null, 'root'), (1, 'child');
      grant select on public.customers, public.orders, public.items, public.transfers, public.nodes to anon, authenticated;
      alter table public.customers enable row level security;
      create policy own on public.customers for select to authenticated using (owner = auth.uid());
      create policy anon_all on public.customers for select to anon using (true);`);
  });
  after(() => t?.close());

  it("embeds the many side as an array, and the one side as an object or null", async () => {
    const r = await get("customers?select=name,orders(id,status)&order=id");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.map((c: any) => [c.name, c.orders.length]), [["Acme", 3], ["Globex", 1], ["Empty Co", 0]], "a customer with no orders gets an empty array");
    assert.deepEqual(r.json[0].orders[0], { id: 1, status: "paid" });
    const o = await get("orders?select=id,customers(name)&order=id");
    assert.deepEqual(o.json.map((x: any) => x.customers), [{ name: "Acme" }, { name: "Acme" }, { name: "Acme" }, { name: "Globex" }]);
    await t.sql(owner, p.ref, "alter table public.orders alter column customer_id drop not null; insert into public.orders (customer_id, status, total) values (null, 'orphan', 1)");
    assert.equal((await get("orders?select=id,customers(name)&status=eq.orphan")).json[0].customers, null, "no related row: null");
    await t.sql(owner, p.ref, "delete from public.orders where status = 'orphan'; alter table public.orders alter column customer_id set not null");
  });

  it("supports aliases, *, nesting, and embeds alongside plain columns", async () => {
    const r = await get("customers?select=*,my_orders:orders(id,items(sku,qty))&id=eq.1");
    assert.deepEqual(Object.keys(r.json[0]).sort(), ["id", "my_orders", "name", "owner"]);
    assert.deepEqual(r.json[0].my_orders.map((o: any) => [o.id, o.items.map((i: any) => i.sku)]), [[1, ["a", "b"]], [2, []], [3, ["c"]]]);
    const only = await get("customers?select=orders(id)&id=eq.2");
    assert.deepEqual(only.json, [{ orders: [{ id: 4 }] }], "asking only for the embed returns only it");
    const deep = await get("items?select=sku,orders(status,customers(name))&order=id");
    assert.deepEqual(deep.json.map((i: any) => [i.sku, i.orders.customers.name]), [["a", "Acme"], ["b", "Acme"], ["c", "Acme"], ["d", "Globex"]]);
    assert.equal((await get("customers?select=a(b(c(d(*))))")).status, 400, "nesting is capped");
  });

  it("filters, orders and limits an embedded resource separately from the parent", async () => {
    const r = await get("customers?select=name,orders(id,total)&orders.status=eq.paid&orders.order=total.desc&orders.limit=1&id=eq.1");
    assert.deepEqual(r.json, [{ name: "Acme", orders: [{ id: 3, total: 300 }] }]);
    const kept = await get("customers?select=name,orders(id)&orders.status=eq.nope&id=eq.1");
    assert.deepEqual(kept.json, [{ name: "Acme", orders: [] }], "a filter on the embed does not remove the parent");
    const nested = await get("customers?select=name,orders(id,items(sku))&orders.items.qty=gte.2&id=eq.1");
    assert.deepEqual(nested.json[0].orders.map((o: any) => o.items.map((i: any) => i.sku)), [["b"], [], ["c"]]);
    const off = await get("customers?select=orders(id)&orders.order=id.asc&orders.offset=1&orders.limit=1&id=eq.1");
    assert.deepEqual(off.json[0].orders, [{ id: 2 }]);
    for (const bad of ["customers?select=name&orders.status=eq.paid", "customers?select=orders(id)&ordres.status=eq.paid", "customers?select=orders(id)&orders.nope=eq.1", "customers?select=orders(id)&orders.limit=x", "customers?select=orders(id)&orders.order=total.sideways"])
      assert.equal((await get(bad)).status, 400, bad);
  });

  it("!inner keeps only parents that have a matching embedded row, and counts agree", async () => {
    const left = await get("customers?select=name,orders(id)&order=id");
    assert.equal(left.json.length, 3);
    const inner = await get("customers?select=name,orders!inner(id)&order=id");
    assert.deepEqual(inner.json.map((c: any) => c.name), ["Acme", "Globex"], "Empty Co has no orders");
    const filtered = await get("customers?select=name,orders!inner(id)&orders.total=gt.200", p.anon, { prefer: "count=exact" });
    assert.deepEqual(filtered.json.map((c: any) => c.name), ["Acme"], "the embed's own filter decides who stays");
    assert.match(String(filtered.headers["content-range"]), /^0-0\/1$/, "the total counts parents after the inner join");
    const deepInner = await get("customers?select=name,orders!inner(items!inner(sku))&order=id");
    assert.deepEqual(deepInner.json.map((c: any) => c.name), ["Acme", "Globex"]);
  });

  it("needs a hint when more than one foreign key connects the tables, and accepts the constraint or column name", async () => {
    const amb = await get("transfers?select=amount,customers(name)");
    assert.equal(amb.status, 300, amb.text);
    assert.equal(amb.json.code, "PGRST201");
    assert.match(amb.json.hint, /customers!transfers_from_customer_fkey, customers!transfers_to_customer_fkey/);
    const a = await get("transfers?select=amount,sender:customers!transfers_from_customer_fkey(name)");
    assert.equal(a.json[0].sender.name, "Acme");
    const b = await get("transfers?select=amount,receiver:customers!to_customer(name)");
    assert.equal(b.json[0].receiver.name, "Globex");
    const rev = await get("customers?select=name,sent:transfers!from_customer(amount)&id=eq.1");
    assert.deepEqual(rev.json[0].sent, [{ amount: 10 }]);
    assert.equal((await get("customers?select=name,transfers(amount)")).status, 300, "from the other side too");
  });

  it("explains a missing relationship, and handles a table that points at itself via a hint", async () => {
    const none = await get("customers?select=name,items(*)");
    assert.equal(none.status, 400);
    assert.equal(none.json.code, "PGRST200");
    assert.match(none.json.message, /relationship between 'customers' and 'items'/);
    assert.equal((await get("customers?select=name,nope(*)")).status, 400);
    assert.equal((await get("customers?select=orders!nofk(id)")).status, 400, "a hint that matches nothing");
    const self = await get("nodes?select=label,nodes!parent_id(label)&order=id");
    assert.equal(self.status, 300, "a self-reference works both ways, so it needs saying which");
  });

  it("applies row-level security to the embedded tables as to the caller", async () => {
    // orders has no RLS here, customers does: embedding customers as ann or bob shows only their own rows.
    const asAnn = await get("orders?select=id,customers(name)&order=id", ann.token);
    assert.deepEqual(asAnn.json.map((o: any) => o.customers?.name ?? null), ["Acme", "Acme", "Acme", null], "bob's customer is hidden from ann even through a join");
    const asBob = await get("orders?select=id,customers(name)&order=id", bob.token);
    assert.deepEqual(asBob.json.map((o: any) => o.customers?.name ?? null), [null, null, null, "Globex"]);
    const own = await get("customers?select=name,orders(id)&order=id", ann.token);
    assert.deepEqual(own.json.map((c: any) => c.name), ["Acme", "Empty Co"]);
    // No privileges on the embedded table means no embed: the whole request is refused, as it would be on its own.
    await t.sql(owner, p.ref, "revoke select on public.items from anon");
    assert.equal((await get("orders?select=id,items(sku)")).status, 401);
    assert.equal((await get("orders?select=id")).status, 200);
    await t.sql(owner, p.ref, "grant select on public.items to anon");
  });

  it("is read-only and is not an injection route", async () => {
    for (const evil of ["customers?select=orders(id);drop table customers", `customers?select=orders("id")`, "customers?select=orders(id,pg_sleep(5))", "customers?select=orders!x(id)"])
      assert.equal((await get(evil)).status, 400, evil);
    assert.equal((await t.gw(p.ref, "POST", "/rest/v1/orders?select=id,items(sku)", { key: p.service, body: { customer_id: 1, status: "x", total: 1 }, headers: { prefer: "return=representation" } })).status, 201, "writes ignore select embeds without breaking");
    const flt = await get(`customers?select=orders(id)&orders.status=eq.${encodeURIComponent("x'; drop table customers; --")}`);
    assert.equal(flt.status, 200, "values are bound, not spliced");
    assert.equal((await get("customers?select=name")).json.length, 3);
    await t.sql(owner, p.ref, "delete from public.orders where status = 'x'");
  });
});
