import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { signJwt } from "./keys.js";
import pg from "pg";
import { type BlobStore, DiskStore, PgStore, S3Store } from "./blobs.js";
import { migrate } from "./migrate.js";
import { StorageService, parseMultipart, validObjectName } from "./storage.js";
import { makeHarness, type Harness, type TestProject } from "./testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
};

describe("object names", () => {
  it("rejects traversal and malformed names", () => {
    for (const n of ["", "/a", "a/", "a//b", "../x", "a/../b", "a/./b", "a\0b", "x".repeat(1025)]) assert.equal(validObjectName(n), false, JSON.stringify(n));
    for (const n of ["a", "a/b/c.txt", "dir/with space/é.png"]) assert.equal(validObjectName(n), true, n);
  });
  it("reads the file part of a multipart body", () => {
    const body = Buffer.from(`--XX\r\nContent-Disposition: form-data; name="cacheControl"\r\n\r\n3600\r\n--XX\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--XX--\r\n`);
    const p = parseMultipart(body, "multipart/form-data; boundary=XX");
    assert.equal(p?.data.toString(), "hello");
    assert.equal(p?.type, "text/plain");
  });
});

// The same suite runs against plain files and, when a server is given, against a real S3 implementation.
const S3_ENDPOINT = process.env.BAAS_TEST_S3_ENDPOINT;
if (process.env.CI && !S3_ENDPOINT) throw new Error("set BAAS_TEST_S3_ENDPOINT so the storage tests run against a real S3 server in CI");
const backends: Array<{ name: string; make: (root: string) => Promise<BlobStore> }> = [
  { name: "disk", make: async (root) => new DiskStore(root) },
  ...(ADMIN ? [{ name: "postgres", make: async () => {
    // A control database of its own, with the blob tables the platform's migrations create.
    const name = `baas_blobs_${Math.random().toString(36).slice(2, 10)}`;
    const admin = new pg.Pool({ connectionString: ADMIN });
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${name}`) });
    await migrate(pool);
    return new PgStore(pool);
  } }] : []),
  ...(S3_ENDPOINT ? [{ name: "s3", make: async () => {
    const store = new S3Store({ endpoint: S3_ENDPOINT, bucket: "baas-test", accessKeyId: process.env.BAAS_TEST_S3_KEY ?? "accessKey1", secretAccessKey: process.env.BAAS_TEST_S3_SECRET ?? "verySecretKey1", prefix: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/` });
    await store.s3.createBucket();
    return store;
  } }] : []),
];

for (const be of backends) describe(`storage (${be.name})`, { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let blobs: BlobStore;
  let h: Harness;
  let a: TestProject;
  let b: TestProject;
  let root: string;
  let u1: any, u2: any;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "baas-storage-"));
    blobs = await be.make(root);
    h = await makeHarness(ADMIN!, (pm) => ({
      services: { storage: new StorageService(pm, { blobs, limits: () => ({ fileSize: 1024, totalBytes: 4096 }) }) },
    }));
    [a, b] = await Promise.all([h.project(), h.project()]);
    await h.sql(a, `
      CREATE POLICY own_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'private' AND (storage.foldername(name))[1] = auth.uid()::text);
    `).catch(() => {}); // storage.foldername does not exist; the real policies follow
    await h.sql(a, `
      DROP POLICY IF EXISTS own_read ON storage.objects;
      CREATE POLICY own_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'private' AND split_part(name, '/', 1) = auth.uid()::text);
      CREATE POLICY own_write ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'private' AND split_part(name, '/', 1) = auth.uid()::text);
      CREATE POLICY own_update ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'private' AND split_part(name, '/', 1) = auth.uid()::text);
      CREATE POLICY own_delete ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'private' AND split_part(name, '/', 1) = auth.uid()::text);`);
    const su = async (p: TestProject, email: string) => (await h.call(p, "POST", "/auth/v1/signup", { key: p.anon, body: { email, password: "secret123" } })).json;
    u1 = await su(a, "s1@example.com");
    u2 = await su(a, "s2@example.com");
    for (const p of [a, b]) {
      await h.call(p, "POST", "/storage/v1/bucket", { key: p.service, body: { id: "private" } });
      await h.call(p, "POST", "/storage/v1/bucket", { key: p.service, body: { id: "pub", public: true } });
    }
  });
  after(async () => {
    await h?.close();
    await rm(root, { recursive: true, force: true });
  });

  const up = (p: TestProject, path: string, data: string | Buffer, o: { key?: string; token?: string; type?: string; headers?: Record<string, string>; method?: string } = {}) =>
    h.call(p, o.method ?? "POST", `/storage/v1/object/${path}`, { key: o.key ?? p.anon, token: o.token, raw: data, headers: { "content-type": o.type ?? "text/plain", ...o.headers } });

  it("manages buckets only with the service key", async () => {
    assert.equal((await h.call(a, "POST", "/storage/v1/bucket", { key: a.anon, body: { id: "x1" } })).status, 403);
    assert.equal((await h.call(a, "POST", "/storage/v1/bucket", { key: a.service, body: { id: "sign" } })).status, 400);
    assert.equal((await h.call(a, "POST", "/storage/v1/bucket", { key: a.service, body: { id: "bad name!" } })).status, 400);
    assert.equal((await h.call(a, "POST", "/storage/v1/bucket", { key: a.service, body: { id: "private" } })).status, 409);
    assert.deepEqual((await h.call(a, "GET", "/storage/v1/bucket", { key: a.service })).json.map((x: any) => x.id), ["private", "pub"]);
    assert.equal((await h.call(a, "GET", "/storage/v1/bucket", { key: a.anon })).status, 403);
    assert.equal((await h.call(a, "GET", "/storage/v1/bucket/nope", { key: a.service })).status, 404);
  });

  it("lets RLS policies decide who may upload and read", async () => {
    assert.equal((await up(a, "private/x.txt", "hi")).status, 401); // anon
    assert.equal((await up(a, `private/${u1.user.id}/a.txt`, "hello", { token: u1.access_token })).status, 200);
    assert.equal((await up(a, `private/${u1.user.id}/b.txt`, "x", { token: u2.access_token })).status, 403); // someone else's folder
    const mine = await h.call(a, "GET", `/storage/v1/object/private/${u1.user.id}/a.txt`, { key: a.anon, token: u1.access_token });
    assert.equal(mine.status, 200);
    assert.equal(mine.text, "hello");
    assert.equal((await h.call(a, "GET", `/storage/v1/object/private/${u1.user.id}/a.txt`, { key: a.anon, token: u2.access_token })).status, 404);
    assert.equal((await h.call(a, "GET", `/storage/v1/object/private/${u1.user.id}/a.txt`, { key: a.anon })).status, 404);
    assert.equal((await h.call(a, "GET", `/storage/v1/object/authenticated/private/${u1.user.id}/a.txt`, { key: a.anon, token: u1.access_token })).status, 200);
    assert.equal((await h.call(a, "GET", `/storage/v1/object/private/${u1.user.id}/a.txt`, { key: a.service })).text, "hello");
  });

  it("serves downloads with safe headers", async () => {
    const r = await h.call(a, "GET", `/storage/v1/object/private/${u1.user.id}/a.txt`, { key: a.service });
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(String(r.headers["content-security-policy"]), /sandbox/);
    assert.equal(r.headers["content-type"], "text/plain");
  });

  it("stores files by id, never by name, and leaves nothing after a rejected upload", async () => {
    // HTTP clients normalise ".." away, so hostile names arrive percent-encoded.
    assert.equal((await up(a, "pub/a%2F..%2Fb", "x", { key: a.service })).status, 400);
    assert.equal((await up(a, "pub/..%2F..%2Fetc%2Fpasswd", "x", { key: a.service })).status, 400);
    assert.equal((await up(a, "pub/%2Fabs", "x", { key: a.service })).status, 400);
    await up(a, "pub/tricky name.html", "<script>1</script>", { key: a.service, type: "text/html" });
    const before = (await blobs.list(a.ref)).length;
    assert.equal((await up(a, "private/denied.txt", "nope", { token: u1.access_token })).status, 403);
    assert.equal((await blobs.list(a.ref)).length, before);
    const files = await blobs.list(a.ref);
    for (const f of files) assert.match(f, /[0-9a-f-]{36}$/);
    assert.ok(!files.some((f) => f.includes("tricky") || f.includes("passwd")));
  });

  it("round-trips file names with percent signs, plus, hash, spaces and unicode", async () => {
    const names = ["100%.txt", "100%25.txt", "a+b.txt", "c#d.txt", "sp ace/é 日本.txt", "q?x=1.txt", "semi;colon.txt"];
    for (const n of names) {
      const path = n.split("/").map(encodeURIComponent).join("/");
      assert.equal((await up(a, `pub/${path}`, `content of ${n}`, { key: a.service })).status, 200, n);
      assert.equal((await h.call(a, "GET", `/storage/v1/object/public/pub/${path}`, {})).text, `content of ${n}`, n);
    }
    const listed = (await h.call(a, "POST", "/storage/v1/object/list/pub", { key: a.service, body: { prefix: "", limit: 1000 } })).json.map((x: any) => x.name);
    for (const top of ["100%.txt", "100%25.txt", "a+b.txt", "c#d.txt", "sp ace"]) assert.ok(listed.includes(top), top);
    // Raw NUL and broken escapes are refused cleanly, never a 500.
    assert.equal((await up(a, "pub/nul%00byte", "x", { key: a.service })).status, 400);
    assert.ok([400, 404].includes((await h.call(a, "GET", "/storage/v1/object/public/pub/%E0%A4%A", {})).status));
    await h.call(a, "DELETE", "/storage/v1/object/pub", { key: a.service, body: { prefixes: names } });
  });

  it("serves public buckets without credentials and hides private ones", async () => {
    await up(a, "pub/hello.txt", "world", { key: a.service });
    const pub = await h.call(a, "GET", "/storage/v1/object/public/pub/hello.txt", {});
    assert.equal(pub.status, 200);
    assert.equal(pub.text, "world");
    assert.equal((await h.call(a, "GET", `/storage/v1/object/public/private/${u1.user.id}/a.txt`, {})).status, 404);
    assert.equal((await h.call(a, "GET", "/storage/v1/object/public/pub/missing.txt", {})).status, 404);
    assert.equal((await h.call(b, "GET", "/storage/v1/object/public/pub/hello.txt", {})).status, 404); // same bucket name, other project
  });

  it("issues signed URLs that work without a key, expire, and cannot be used as API keys", async () => {
    const path = `${u1.user.id}/a.txt`;
    assert.equal((await h.call(a, "POST", `/storage/v1/object/sign/private/${path}`, { key: a.anon, token: u2.access_token, body: { expiresIn: 60 } })).status, 404);
    const s = await h.call(a, "POST", `/storage/v1/object/sign/private/${path}`, { key: a.anon, token: u1.access_token, body: { expiresIn: 60 } });
    assert.equal(s.status, 200);
    const got = await h.call(a, "GET", `/storage/v1${s.json.signedURL}`, {});
    assert.equal(got.status, 200);
    assert.equal(got.text, "hello");
    const token = new URL(`http://x${s.json.signedURL}`).searchParams.get("token")!;
    assert.equal((await h.call(a, "GET", `/storage/v1/object/sign/private/${u1.user.id}/other.txt?token=${token}`, {})).status, 400); // other object
    assert.equal((await h.call(a, "GET", `/storage/v1/object/sign/private/${path}?token=${token}x`, {})).status, 400);
    assert.equal((await h.call(b, "GET", `/storage/v1/object/sign/private/${path}?token=${token}`, {})).status, 400); // other project
    const expired = signJwt({ role: "storage_signed", url: `private/${path}`, exp: 1 }, a.jwtSecret);
    assert.equal((await h.call(a, "GET", `/storage/v1/object/sign/private/${path}?token=${expired}`, {})).status, 400);
    assert.equal((await h.call(a, "GET", "/rest/v1/", { key: token })).status, 401);
  });

  it("enforces size, mime and quota limits", async () => {
    assert.equal((await up(a, "pub/big.bin", Buffer.alloc(2000), { key: a.service })).status, 413);
    await h.call(a, "POST", "/storage/v1/bucket", { key: a.service, body: { id: "images", allowed_mime_types: ["image/*"], file_size_limit: 10 } });
    assert.equal((await up(a, "images/a.txt", "x", { key: a.service })).status, 415);
    assert.equal((await up(a, "images/a.png", "0123456789ab", { key: a.service, type: "image/png" })).status, 413);
    assert.equal((await up(a, "images/a.png", "tiny", { key: a.service, type: "image/png" })).status, 200);
    const q = await h.project();
    await h.call(q, "POST", "/storage/v1/bucket", { key: q.service, body: { id: "q" } });
    for (let i = 0; i < 4; i++) assert.equal((await up(q, `q/f${i}`, Buffer.alloc(1000), { key: q.service })).status, 200);
    assert.equal((await up(q, "q/f4", Buffer.alloc(1000), { key: q.service })).status, 413);
  });

  it("rejects duplicates unless upserting, and replaces content on upsert", async () => {
    assert.equal((await up(a, "pub/dup.txt", "one", { key: a.service })).status, 200);
    assert.equal((await up(a, "pub/dup.txt", "two", { key: a.service })).status, 409);
    assert.equal((await up(a, "pub/dup.txt", "two", { key: a.service, headers: { "x-upsert": "true" } })).status, 200);
    assert.equal((await up(a, "pub/dup.txt", "three", { key: a.service, method: "PUT" })).status, 200);
    assert.equal((await h.call(a, "GET", "/storage/v1/object/public/pub/dup.txt", {})).text, "three");
    assert.equal((await h.sql(a, "SELECT count(*)::int AS n FROM storage.objects WHERE name = 'dup.txt'"))[0].n, 1);
  });

  it("accepts multipart uploads", async () => {
    const body = `--B\r\nContent-Disposition: form-data; name="file"; filename="m.txt"\r\nContent-Type: text/plain\r\n\r\nmultipart!\r\n--B--\r\n`;
    const r = await up(a, "pub/m.txt", body, { key: a.service, type: "multipart/form-data; boundary=B" });
    assert.equal(r.status, 200);
    assert.equal((await h.call(a, "GET", "/storage/v1/object/public/pub/m.txt", {})).text, "multipart!");
  });

  it("lists folders and files, moves, copies and deletes", async () => {
    for (const n of ["docs/a.txt", "docs/b.txt", "docs/sub/c.txt", "top.txt"]) await up(a, `pub/${n}`, n, { key: a.service });
    const root_ = (await h.call(a, "POST", "/storage/v1/object/list/pub", { key: a.service, body: { prefix: "" } })).json.map((x: any) => [x.name, x.id === null ? "folder" : "file"]);
    assert.deepEqual(root_.filter((x: any) => ["docs", "top.txt"].includes(x[0])), [["docs", "folder"], ["top.txt", "file"]]);
    const docs = (await h.call(a, "POST", "/storage/v1/object/list/pub", { key: a.service, body: { prefix: "docs" } })).json;
    assert.deepEqual(docs.map((x: any) => x.name), ["a.txt", "b.txt", "sub"]);
    assert.equal(docs[0].metadata.size, 10);
    assert.deepEqual((await h.call(a, "POST", "/storage/v1/object/list/pub", { key: a.service, body: { prefix: "docs", search: "b." } })).json.map((x: any) => x.name), ["b.txt"]);

    assert.equal((await h.call(a, "POST", "/storage/v1/object/copy", { key: a.service, body: { bucketId: "pub", sourceKey: "docs/a.txt", destinationKey: "docs/a2.txt" } })).status, 200);
    assert.equal((await h.call(a, "GET", "/storage/v1/object/public/pub/docs/a2.txt", {})).text, "docs/a.txt");
    assert.equal((await h.call(a, "POST", "/storage/v1/object/move", { key: a.service, body: { bucketId: "pub", sourceKey: "docs/a2.txt", destinationKey: "moved.txt" } })).status, 200);
    assert.equal((await h.call(a, "GET", "/storage/v1/object/public/pub/docs/a2.txt", {})).status, 404);
    assert.equal((await h.call(a, "GET", "/storage/v1/object/public/pub/moved.txt", {})).text, "docs/a.txt");

    const filesBefore = (await blobs.list(a.ref)).length;
    const del = await h.call(a, "DELETE", "/storage/v1/object/pub", { key: a.service, body: { prefixes: ["moved.txt", "top.txt", "ghost"] } });
    assert.deepEqual(del.json.map((x: any) => x.name).sort(), ["moved.txt", "top.txt"]);
    assert.equal((await blobs.list(a.ref)).length, filesBefore - 2);
    assert.equal((await h.call(a, "DELETE", "/storage/v1/object/pub/docs/b.txt", { key: a.service })).status, 200);
    assert.equal((await h.call(a, "DELETE", "/storage/v1/object/pub/docs/b.txt", { key: a.service })).status, 404);
  });

  it("refuses to delete a non-empty bucket, and empties then deletes", async () => {
    assert.equal((await h.call(a, "DELETE", "/storage/v1/bucket/pub", { key: a.service })).status, 409);
    assert.equal((await h.call(a, "POST", "/storage/v1/bucket/pub/empty", { key: a.service })).status, 200);
    assert.equal((await h.call(a, "DELETE", "/storage/v1/bucket/pub", { key: a.service })).status, 200);
  });

  it("removes a project's files when it is purged", async () => {
    const p = await h.project();
    await h.call(p, "POST", "/storage/v1/bucket", { key: p.service, body: { id: "z" } });
    await up(p, "z/f", "data", { key: p.service });
    assert.ok((await blobs.list(p.ref)).length > 0);
    await new StorageService(h.pm, { blobs }).purgeProject(p.ref);
    assert.equal((await blobs.list(p.ref)).length, 0);
    if (be.name === "disk") assert.equal(await readFile(join(root, "nope")).catch(() => "gone"), "gone");
  });
});
