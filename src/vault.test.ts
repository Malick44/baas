import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Vault } from "./vault.js";

const KEY = "ab".repeat(32);

describe("vault", () => {
  it("round-trips and never repeats a ciphertext", () => {
    const v = new Vault(KEY);
    const a = v.seal("hunter2", "ref1");
    assert.equal(v.open(a, "ref1"), "hunter2");
    assert.notEqual(a, v.seal("hunter2", "ref1"));
    assert.ok(!a.includes("hunter2"));
  });

  it("refuses a ciphertext moved to another project", () => {
    const v = new Vault(KEY);
    assert.throws(() => v.open(v.seal("s", "ref1"), "ref2"));
  });

  it("refuses tampered ciphertext and the wrong master key", () => {
    const v = new Vault(KEY);
    const sealed = v.seal("s", "ref1");
    const [a, iv, tag, ct] = sealed.split(".") as [string, string, string, string];
    const flipped = ct.slice(0, -2) + (ct.endsWith("AA") ? "BB" : "AA");
    assert.throws(() => v.open([a, iv, tag, flipped].join("."), "ref1"));
    assert.throws(() => new Vault("cd".repeat(32)).open(sealed, "ref1"));
  });

  it("rejects malformed master keys", () => {
    assert.throws(() => new Vault("short"));
    assert.throws(() => new Vault("zz".repeat(32)));
  });
});
