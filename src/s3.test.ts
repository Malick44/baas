import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DiskStore, S3Store } from "./blobs.js";
import { awsEncode, S3, S3Error, signV4 } from "./s3.js";
import { migrateStorage } from "./storage-migrate.js";
import { makePlatform } from "./platform-testkit.js";

const ENDPOINT = process.env.BAAS_TEST_S3_ENDPOINT;
const KEY = process.env.BAAS_TEST_S3_KEY ?? "accessKey1";
const SECRET = process.env.BAAS_TEST_S3_SECRET ?? "verySecretKey1";
const ADMIN = process.env.BAAS_TEST_PG_URL;
if (process.env.CI && !ENDPOINT) throw new Error("set BAAS_TEST_S3_ENDPOINT so the S3 tests run against a real server in CI");

describe("request signing", () => {
  it("reproduces the signature in AWS's documentation (GET Object with a Range header)", () => {
    const h = signV4({ method: "GET", path: "/test.txt", host: "examplebucket.s3.amazonaws.com", headers: { range: "bytes=0-9" }, payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", date: new Date("2013-05-24T00:00:00Z") });
    assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    assert.equal(h["x-amz-date"], "20130524T000000Z");
  });

  it("reproduces the signature in AWS's documentation for a query string (GET Bucket lifecycle)", () => {
    const h = signV4({ method: "GET", path: "/", query: { lifecycle: "" }, host: "examplebucket.s3.amazonaws.com", payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", date: new Date("2013-05-24T00:00:00Z") });
    assert.match(h.authorization!, /Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543$/);
  });

  it("encodes the way SigV4 wants", () => {
    assert.equal(awsEncode("a b/c+d&e=f!g'h(i)j*k~l-m_n.o"), "a%20b%2Fc%2Bd%26e%3Df%21g%27h%28i%29j%2Ak~l-m_n.o");
    assert.equal(awsEncode("dir/é ü/x", true), "dir/%C3%A9%20%C3%BC/x");
  });

  it("refuses to build a client without what it needs, or with a bad address", () => {
    assert.throws(() => new S3({ endpoint: "ftp://x", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }), /http/);
    assert.throws(() => new S3({ endpoint: "http://x", bucket: "", accessKeyId: "a", secretAccessKey: "s" }), /needs a bucket/);
  });
});

describe("an S3 server", { skip: !ENDPOINT && "set BAAS_TEST_S3_ENDPOINT to a running S3-compatible server" }, () => {
  const prefix = `s3-${Date.now()}-${randomBytes(3).toString("hex")}/`;
  let s3: S3;
  const cfg = (o = {}) => ({ endpoint: ENDPOINT!, bucket: "baas-test", accessKeyId: KEY, secretAccessKey: SECRET, prefix, ...o });
  before(async () => {
    s3 = new S3(cfg());
    await s3.createBucket();
    await s3.check();
  });

  it("stores, reads back, checks, copies and deletes", async () => {
    await s3.put("a/b.txt", Buffer.from("hello"), "text/plain");
    const got = await s3.get("a/b.txt");
    assert.equal(got!.size, 5);
    assert.equal((await new Response(got!.stream as never).text()), "hello");
    assert.equal(await s3.exists("a/b.txt"), true);
    assert.equal(await s3.exists("a/none.txt"), false);
    assert.equal(await s3.get("a/none.txt"), null);
    await s3.copy("a/b.txt", "a/c.txt");
    assert.equal(await new Response((await s3.get("a/c.txt"))!.stream as never).text(), "hello");
    await s3.delete("a/b.txt");
    assert.equal(await s3.exists("a/b.txt"), false);
    await s3.delete("a/b.txt"); // deleting what is not there is fine
    await s3.delete("a/c.txt");
  });

  it("keeps odd names intact: spaces, unicode and the characters AWS encodes specially", async () => {
    const names = ["with space.txt", "é/ü/日本語.txt", "sym!bols'(a)*b.txt", "plus+and&equals=.txt", "a%20b.txt", "tilde~dot.-_.x", "deep/er/and/deeper/file"];
    for (const n of names) await s3.put(`odd/${n}`, Buffer.from(n));
    for (const n of names) assert.equal(await new Response((await s3.get(`odd/${n}`))!.stream as never).text(), n, n);
    assert.deepEqual((await s3.list("odd/")).sort(), names.map((n) => `odd/${n}`).sort());
    await s3.deleteMany(names.map((n) => `odd/${n}`));
    assert.deepEqual(await s3.list("odd/"), []);
  });

  it("moves several megabytes without changing a byte", async () => {
    const data = randomBytes(6 * 1024 * 1024);
    await s3.put("big/blob.bin", data);
    const got = await s3.get("big/blob.bin");
    assert.equal(got!.size, data.length);
    const chunks: Buffer[] = [];
    for await (const c of got!.stream) chunks.push(Buffer.from(c));
    assert.equal(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"), createHash("sha256").update(data).digest("hex"));
    await s3.put("big/empty", Buffer.alloc(0));
    assert.equal((await s3.get("big/empty"))!.size, 0);
  });

  it("lists past one page and deletes in batches", async () => {
    const keys = Array.from({ length: 1105 }, (_, i) => `many/k${String(i).padStart(4, "0")}`);
    for (let i = 0; i < keys.length; i += 40) await Promise.all(keys.slice(i, i + 40).map((k) => s3.put(k, Buffer.from("x"))));
    const listed = await s3.list("many/");
    assert.equal(listed.length, 1105, "every page was followed");
    assert.equal(new Set(listed).size, 1105);
    await s3.deleteMany(listed);
    assert.deepEqual(await s3.list("many/"), []);
  });

  it("is kept apart by prefix, so one bucket can serve several installations", async () => {
    const other = new S3(cfg({ prefix: `other-${prefix}` }));
    await other.put("same-name", Buffer.from("theirs"));
    await s3.put("same-name", Buffer.from("ours"));
    assert.equal(await new Response((await other.get("same-name"))!.stream as never).text(), "theirs");
    assert.deepEqual(await s3.list("same-name"), ["same-name"]);
    await other.delete("same-name");
    await s3.delete("same-name");
  });

  it("says what went wrong: a wrong secret, a missing bucket", async () => {
    const bad = new S3(cfg({ secretAccessKey: "not-the-secret" }));
    await assert.rejects(bad.put("x", Buffer.from("x")), (e: S3Error) => e instanceof S3Error && e.status === 403 && /SignatureDoesNotMatch/.test(e.code));
    await assert.rejects(new S3(cfg({ accessKeyId: "nobody" })).check(), (e: S3Error) => e.status === 403);
    await assert.rejects(new S3(cfg({ bucket: "no-such-bucket-here" })).check(), (e: S3Error) => e.status === 404);
    await assert.rejects(new S3({ ...cfg(), endpoint: "http://127.0.0.1:1" }).check(), (e: S3Error) => e.code === "Unreachable");
  });

  it("is the BlobStore the platform uses, and turns backend trouble into a 502", async () => {
    const store = new S3Store(cfg());
    await store.put("bs/one", Buffer.from("1"));
    assert.deepEqual(await store.list("bs/"), ["bs/one"]);
    await store.deletePrefix("bs");
    assert.equal(await store.exists("bs/one"), false);
    const broken = new S3Store(cfg({ secretAccessKey: "wrong" }));
    await assert.rejects(broken.put("x", Buffer.from("x")), (e: { status?: number }) => e.status === 502);
  });
});

describe("moving from disk to S3", { skip: (!ENDPOINT || !ADMIN) && "needs BAAS_TEST_S3_ENDPOINT and BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let dir: string;
  after(async () => { await t?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

  it("copies what is missing, once, and serves it from the bucket", async () => {
    dir = await mkdtemp(join(tmpdir(), "baas-s3mig-"));
    // Start on plain files, store some objects ...
    t = await makePlatform(ADMIN!, { storageDir: join(dir, "files") });
    const owner = await t.org();
    const p = await t.project(owner, "to-s3");
    const up = (name: string, body: string) => t.platform.gateway.inject({ method: "POST", url: `/storage/v1/object/b/${name}`, headers: { host: `${p.ref}.localhost`, apikey: p.service, authorization: `Bearer ${p.service}`, "content-type": "text/plain" }, payload: body });
    await t.gw(p.ref, "POST", "/storage/v1/bucket", { key: p.service, body: { id: "b", name: "b", public: true } });
    for (const n of ["one.txt", "two.txt", "three.txt"]) assert.equal((await up(n, `body of ${n}`)).statusCode, 200);
    await t.platform.stop();

    // ... then switch the same installation to an S3 bucket.
    const { createPlatform } = await import("./platform.js");
    const prefix = `mig-${Date.now()}/`;
    const switched = await createPlatform({ ...t.platform.cfg, s3: { endpoint: ENDPOINT!, bucket: "baas-test", accessKeyId: KEY, secretAccessKey: SECRET, prefix } });
    try {
      const read = (n: string) => switched.gateway.inject({ method: "GET", url: `/storage/v1/object/public/b/${n}`, headers: { host: `${p.ref}.localhost`, apikey: p.anon } });
      assert.equal((await read("one.txt")).statusCode, 404, "the bucket is empty until the files are copied");
      const op = { "x-bootstrap-token": "bootstrap-token-for-tests-1234567890" };
      const first = await switched.api.inject({ method: "POST", url: "/v1/admin/storage/migrate", headers: { ...op, "content-type": "application/json" }, payload: "{}" });
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(JSON.parse(first.body), { projects: 1, objects: 3, copied: 3, alreadyThere: 0, missingAtSource: 0, failed: 0 });
      for (const n of ["one.txt", "two.txt", "three.txt"]) assert.equal((await read(n)).body, `body of ${n}`);
      const again = JSON.parse((await switched.api.inject({ method: "POST", url: "/v1/admin/storage/migrate", headers: { ...op, "content-type": "application/json" }, payload: "{}" })).body);
      assert.deepEqual(again, { projects: 1, objects: 3, copied: 0, alreadyThere: 3, missingAtSource: 0, failed: 0 }, "running it again changes nothing");
      assert.equal((await switched.api.inject({ method: "POST", url: "/v1/admin/storage/migrate", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode, 401);
      // New uploads go to the bucket, not to disk.
      const fresh = await switched.gateway.inject({ method: "POST", url: "/storage/v1/object/b/new.txt", headers: { host: `${p.ref}.localhost`, apikey: p.service, authorization: `Bearer ${p.service}`, "content-type": "text/plain" }, payload: "new" });
      assert.equal(fresh.statusCode, 200);
      const diskKeys = await new DiskStore(join(dir, "files")).list(p.ref);
      assert.equal(diskKeys.length, 3, "nothing new was written to the old directory");
      void migrateStorage;
    } finally { await switched.stop(); }
  });

  it("refuses to start when the bucket cannot be used", async () => {
    const { createPlatform } = await import("./platform.js");
    await assert.rejects(createPlatform({ ...t.platform.cfg, s3: { endpoint: ENDPOINT!, bucket: "baas-no-such-bucket", accessKeyId: KEY, secretAccessKey: SECRET } }), /cannot use the S3 bucket "baas-no-such-bucket"/);
  });
});
