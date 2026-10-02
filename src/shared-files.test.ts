import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PgStore } from "./blobs.js";
import { createPlatform, type Platform } from "./platform.js";
import { BOOT, makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

// Two baas processes with NOTHING in common but the databases: separate storage and backup directories.
describe("files and backups shared through Postgres, with no shared filesystem", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let A: Platform;
  let B: Platform;
  let owner: string;
  let dirs: string[] = [];
  const via = (n: Platform, ref: string, method: string, url: string, o: { key?: string; raw?: Buffer | string; type?: string; body?: unknown } = {}) =>
    n.gateway.inject({ method: method as "GET", url, headers: { host: `${ref}.localhost`, ...(o.key ? { apikey: o.key } : {}), ...(o.raw !== undefined ? { "content-type": o.type ?? "text/plain" } : o.body !== undefined ? { "content-type": "application/json" } : {}) }, payload: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) })
      .then((r) => ({ status: r.statusCode, text: r.body, buf: r.rawPayload, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })() }));
  const apiVia = (n: Platform, method: string, url: string, o: { token?: string; body?: unknown } = {}) =>
    n.api.inject({ method: method as "GET", url, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}) }, payload: o.body === undefined ? undefined : JSON.stringify(o.body) })
      .then((r) => ({ status: r.statusCode, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })(), text: r.body }));

  before(async () => {
    const mk = async (n: string) => { const d = await mkdtemp(join(tmpdir(), `baas-shared-${n}-`)); dirs.push(d); return d; };
    t = await makePlatform(ADMIN!, { storageBackend: "postgres" });
    A = t.platform;
    B = await createPlatform({ ...A.cfg, storageDir: await mk("storage"), backupDir: await mk("backups") });
    owner = await t.org();
  });
  after(async () => { await B?.stop().catch(() => {}); await t?.close(); for (const d of dirs) await rm(d, { recursive: true, force: true }); });

  it("serves a file uploaded through one node from the other", async () => {
    const p = await t.project(owner, "shared-files");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
    assert.equal((await via(A, p.ref, "POST", "/storage/v1/bucket", { key: p.service, body: { id: "files", name: "files", public: true } })).status, 200);
    const big = Buffer.alloc(2_600_000, "x");
    big.write("start", 0);
    big.write("end", big.length - 3);
    assert.equal((await via(A, p.ref, "POST", "/storage/v1/object/files/small.txt", { key: p.service, raw: "hello from A" })).status, 200);
    assert.equal((await via(A, p.ref, "POST", "/storage/v1/object/files/big.bin", { key: p.service, raw: big, type: "application/octet-stream" })).status, 200);
    const small = await via(B, p.ref, "GET", "/storage/v1/object/public/files/small.txt");
    assert.equal(small.text, "hello from A", "node B has no copy on its own disk and still serves it");
    const got = await via(B, p.ref, "GET", "/storage/v1/object/public/files/big.bin");
    assert.equal(got.status, 200);
    assert.equal(got.buf.length, big.length, "a file that spans several chunks");
    assert.ok(got.buf.equals(big), "byte for byte");
    // Copy and delete go through the shared store too.
    assert.equal((await via(B, p.ref, "POST", "/storage/v1/object/copy", { key: p.service, body: { bucketId: "files", sourceKey: "small.txt", destinationKey: "copy.txt" } })).status, 200);
    assert.equal((await via(A, p.ref, "GET", "/storage/v1/object/public/files/copy.txt")).text, "hello from A");
    assert.equal((await via(A, p.ref, "DELETE", "/storage/v1/object/files/small.txt", { key: p.service })).status, 200);
    assert.equal((await via(B, p.ref, "GET", "/storage/v1/object/public/files/small.txt")).status, 404);
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM blob_objects WHERE key LIKE $1`, [`${p.ref}/%`])).rows[0].n, 2, "big and copy are left");
  });

  it("restores on one node a backup taken on the other", async () => {
    const p = await t.project(owner, "shared-backups");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
    await t.sql(owner, p.ref, "create table public.keep (n int); insert into public.keep values (1), (2)");
    const bk = await apiVia(A, "POST", `/v1/projects/${p.ref}/backups`, { token: owner, body: {} });
    assert.equal(bk.status, 201, bk.text);
    assert.equal(bk.json.status, "complete");
    assert.ok((await t.platform.control.pool.query(`SELECT 1 FROM blob_objects WHERE key = $1`, [`backups/${p.ref}/${bk.json.id}.dump`])).rowCount === 1, "kept in the shared store");
    await t.sql(owner, p.ref, "delete from public.keep");
    const r = await apiVia(B, "POST", `/v1/projects/${p.ref}/backups/${bk.json.id}/restore`, { token: owner, body: {} });
    assert.equal(r.status, 200, r.text);
    const j = (await t.sql(owner, p.ref, "select n from public.keep order by n")).json;
    assert.deepEqual((Array.isArray(j) ? j : j.results).at(-1).rows.map((x: any) => x[0]), [1, 2], "restored by the node that did not take it");
    assert.equal((await apiVia(B, "DELETE", `/v1/projects/${p.ref}/backups/${bk.json.id}`, { token: owner })).status, 204);
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM blob_objects WHERE key LIKE $1`, [`backups/${p.ref}/%`])).rows[0].n, 0, "and removed from the store");
  });

  it("moves files and backups from disk into Postgres, once, leaving the originals", async () => {
    const disk = await makePlatform(ADMIN!);
    try {
      const o = await disk.org();
      const p = await disk.project(o, "was-on-disk");
      await disk.api("PATCH", `/v1/projects/${p.ref}`, { token: o, body: { plan: "pro" } });
      await disk.gw(p.ref, "POST", "/storage/v1/bucket", { key: p.service, body: { id: "files", name: "files", public: true } });
      assert.equal((await disk.gw(p.ref, "POST", "/storage/v1/object/files/old.txt", { key: p.service, raw: "from the disk", headers: { "content-type": "text/plain" } })).status, 200);
      const bk = await disk.api("POST", `/v1/projects/${p.ref}/backups`, { token: o, body: {} });
      assert.equal(bk.status, 201, bk.text);
      // The same control database and files, now with Postgres as the store.
      const moved = await createPlatform({ ...disk.platform.cfg, storageBackend: "postgres" });
      try {
        const run = () => moved.api.inject({ method: "POST", url: "/v1/admin/storage/migrate", headers: { "x-bootstrap-token": BOOT } }).then((r) => ({ status: r.statusCode, json: JSON.parse(r.body) }));
        const first = await run();
        assert.equal(first.status, 200, JSON.stringify(first.json));
        assert.equal(first.json.copied, 1);
        assert.deepEqual(first.json.backups, { copied: 1, alreadyThere: 0, missing: 0, failed: 0 });
        const second = await run();
        assert.equal(second.json.copied, 0);
        assert.equal(second.json.alreadyThere, 1);
        assert.deepEqual(second.json.backups, { copied: 0, alreadyThere: 1, missing: 0, failed: 0 });
        const served = await moved.gateway.inject({ method: "GET", url: "/storage/v1/object/public/files/old.txt", headers: { host: `${p.ref}.localhost` } });
        assert.equal(served.body, "from the disk");
      } finally { await moved.stop().catch(() => {}); }
    } finally { await disk.close(); }
  });
});
