import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify, parseEnv } from "node:util";

const exec = promisify(execFile);
const script = new URL("../scripts/setup-initial-users.mjs", import.meta.url).pathname;

describe("private initial-user credential setup", () => {
  let root: string;
  let path: string;
  const args = () => [script, "--output-env", path, "--organization-name", "My Organization", "--organization-slug", "my-org", "--owner-email", "owner@example.com", "--admin-email", "admin@example.com"];
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "baas-initial-setup-")); path = join(root, ".env.local"); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("preserves unrelated bytes, generates independent passwords privately, and refuses to rotate them on rerun", async () => {
    const original = "# existing env\nUNCHANGED='literal-value'\r\nOTHER=dummy-only-no-final-newline";
    await writeFile(path, original, { mode: 0o644 });
    const { stdout, stderr } = await exec(process.execPath, args());
    const saved = await readFile(path, "utf8");
    assert.ok(saved.startsWith(original));
    const env = parseEnv(saved);
    assert.equal(env.BAAS_INITIAL_OWNER_EMAIL, "owner@example.com");
    assert.equal(env.BAAS_INITIAL_ADMIN_EMAIL, "admin@example.com");
    assert.equal(env.BAAS_INITIAL_ORGANIZATION_NAME, "My Organization");
    assert.equal(env.BAAS_INITIAL_USERS_ENABLED, "true");
    for (const password of [env.BAAS_INITIAL_OWNER_PASSWORD!, env.BAAS_INITIAL_ADMIN_PASSWORD!]) {
      assert.match(password, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!stdout.includes(password) && !stderr.includes(password));
    }
    assert.notEqual(env.BAAS_INITIAL_OWNER_PASSWORD, env.BAAS_INITIAL_ADMIN_PASSWORD);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await exec(process.execPath, args());
    assert.equal(await readFile(path, "utf8"), saved);
  });

  it("refuses partial configuration, duplicate keys, and symbolic links without modifying the destination", async () => {
    for (const text of ["BAAS_INITIAL_OWNER_PASSWORD=dummy\n", "BAAS_INITIAL_OWNER_EMAIL=a@example.com\nBAAS_INITIAL_OWNER_EMAIL=b@example.com\n"]) {
      await writeFile(path, text);
      await assert.rejects(exec(process.execPath, args()));
      assert.equal(await readFile(path, "utf8"), text);
    }
    await rm(path);
    const target = join(root, "target");
    await writeFile(target, "untouched\n");
    await symlink(target, path);
    await assert.rejects(exec(process.execPath, args()), /regular file/);
    assert.equal(await readFile(target, "utf8"), "untouched\n");
  });

  it("rejects matching emails and honors an existing setup lock", async () => {
    const same = args();
    same[same.length - 1] = "OWNER@example.com";
    await assert.rejects(exec(process.execPath, same), /distinct addresses/);
    await writeFile(`${path}.initial-users.lock`, "dummy lock");
    await assert.rejects(exec(process.execPath, args()), /setup is locked/);
    await assert.rejects(stat(path), { code: "ENOENT" });
  });
});
