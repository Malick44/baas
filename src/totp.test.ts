import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base32Decode, base32Encode, codeFor, matchStep, newSecret, otpauthUri, stepAt } from "./totp.js";

// RFC 6238 appendix B: the shared secret is the ASCII string "12345678901234567890" (SHA-1), 8 digits.
const RFC = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    for (const [t, want] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const)
      assert.equal(codeFor(RFC, stepAt(t * 1000), 8), want, `T=${t}`);
  });
  it("round-trips base32 and makes unguessable secrets", () => {
    for (const hex of ["", "00", "ff", "0123456789abcdef", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]) assert.equal(base32Decode(base32Encode(Buffer.from(hex, "hex"))).toString("hex"), hex);
    assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
    const a = newSecret(), b = newSecret();
    assert.match(a, /^[A-Z2-7]{32}$/);
    assert.notEqual(a, b);
    assert.throws(() => base32Decode("not*base32"));
  });
  it("accepts the current code and one step of drift either way, and nothing else", () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    for (const d of [-1, 0, 1]) assert.equal(matchStep(RFC, codeFor(RFC, s + d), now), s + d);
    for (const d of [-2, 2, 10]) assert.equal(matchStep(RFC, codeFor(RFC, s + d), now), null, `drift ${d}`);
    for (const bad of ["", "12345", "1234567", "abcdef", " 123456", "123456\n"]) assert.equal(matchStep(RFC, bad, now), null, JSON.stringify(bad));
  });
  it("refuses a step that was already used, or an older one", () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    assert.equal(matchStep(RFC, codeFor(RFC, s), now, s), null, "the same code twice");
    assert.equal(matchStep(RFC, codeFor(RFC, s - 1), now, s), null, "an older code after a newer one");
    assert.equal(matchStep(RFC, codeFor(RFC, s + 1), now, s), s + 1, "a newer one still works");
  });
  it("builds the address authenticator apps read", () => {
    const u = new URL(otpauthUri("ABCDEF234567", "ann@example.com", "My App"));
    assert.equal(u.protocol, "otpauth:");
    assert.equal(decodeURIComponent(u.pathname), "/My App:ann@example.com");
    assert.equal(u.hostname, "totp");
    assert.equal(u.searchParams.get("secret"), "ABCDEF234567");
    assert.equal(u.searchParams.get("issuer"), "My App");
    assert.deepEqual([u.searchParams.get("digits"), u.searchParams.get("period"), u.searchParams.get("algorithm")], ["6", "30", "SHA1"]);
  });
});
