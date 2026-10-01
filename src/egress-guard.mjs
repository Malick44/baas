// Runs inside the sandboxed child process, before any function code. It narrows what that code can reach:
//  - fetch() is replaced by one that refuses private, loopback and link-local destinations (unless allowed), resolves each name once and
//    connects to the address it checked (so DNS cannot answer differently the second time), and re-checks every redirect;
//  - the Node modules that open sockets, spawn, signal or inspect are not importable, and the escape hatches around imports are removed;
//  - process.kill is removed: the child shares a user with the server, so it could otherwise signal it.
// This is defence in depth on top of the permission model, not a replacement for network-level isolation (see the README).
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { isBuiltin, registerHooks } from "node:module";
import zlib from "node:zlib";

const blocked = new BlockList();
for (const [n, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]]) blocked.addSubnet(n, p, "ipv4");
for (const [n, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]]) blocked.addSubnet(n, p, "ipv6");

export function isPrivateAddress(addr) {
  let a = addr;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
  if (dotted) a = dotted[1];
  else if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  const family = isIP(a);
  return !family || blocked.check(a, family === 6 ? "ipv6" : "ipv4");
}

const SAFE = new Set(["assert", "assert/strict", "async_hooks", "buffer", "console", "crypto", "events", "path", "path/posix", "perf_hooks", "process", "querystring",
  "stream", "stream/promises", "stream/web", "string_decoder", "timers", "timers/promises", "url", "util", "util/types", "zlib"]);
const MAX_BODY = 6 * 1024 * 1024;
const MAX_HOPS = 5;

export function installEgressGuard({ mode, allow = [] }) {
  const allowed = new Set(allow.map((x) => x.toLowerCase()));
  const open = mode === "open";

  async function pin(url) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`fetch: only http and https are allowed (got ${url.protocol})`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns.lookup(host, { all: true });
    if (!addrs.length) throw new TypeError(`fetch: could not resolve ${host}`);
    const exempt = open || allowed.has(`${url.hostname.toLowerCase()}:${port}`);
    if (!exempt && addrs.some((a) => isPrivateAddress(a.address))) throw new TypeError("fetch: this address is on a private or local network, which functions may not reach");
    return { host, address: addrs[0].address, family: addrs[0].family };
  }

  function once(url, method, headers, body, signal) {
    return pin(url).then((t) => new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request({
        hostname: t.host, port: url.port || undefined, path: `${url.pathname}${url.search}`, method, headers,
        servername: isIP(t.host) ? undefined : t.host,
        lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: t.address, family: t.family }]) : cb(null, t.address, t.family)),
      }, (res) => {
        const parts = []; let n = 0;
        res.on("data", (d) => { n += d.length; if (n > MAX_BODY) { req.destroy(new Error("fetch: response too large")); return; } parts.push(d); });
        res.on("end", () => resolve({ res, body: Buffer.concat(parts) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      if (signal) {
        if (signal.aborted) { req.destroy(signal.reason ?? new Error("aborted")); return; }
        signal.addEventListener("abort", () => req.destroy(signal.reason ?? new Error("aborted")), { once: true });
      }
      req.end(body);
    }));
  }

  function decode(buf, encoding) {
    const e = String(encoding || "").toLowerCase();
    const opts = { maxOutputLength: MAX_BODY };
    if (e === "gzip" || e === "x-gzip") return zlib.gunzipSync(buf, opts);
    if (e === "deflate") return zlib.inflateSync(buf, opts);
    if (e === "br") return zlib.brotliDecompressSync(buf, opts);
    return buf;
  }

  const guardedFetch = async function fetch(input, init) {
    const req = new Request(input, init);
    const mode = init?.redirect ?? req.redirect ?? "follow";
    const signal = init?.signal ?? req.signal;
    let method = req.method;
    let body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    let url = new URL(req.url);
    const headers = {};
    for (const [k, v] of req.headers) headers[k] = v;
    if (!headers["accept-encoding"]) headers["accept-encoding"] = "gzip, deflate, br";
    if (body && !headers["content-length"]) headers["content-length"] = String(body.length);
    for (let hop = 0; ; hop++) {
      const { res, body: raw } = await once(url, method, headers, body, signal);
      const status = res.statusCode;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc && mode !== "manual") {
        if (mode === "error") throw new TypeError("fetch: redirect not allowed");
        if (hop >= MAX_HOPS) throw new TypeError("fetch: too many redirects");
        const next = new URL(loc, url);
        if (next.origin !== url.origin) { delete headers.authorization; delete headers.cookie; }
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) { method = "GET"; body = undefined; delete headers["content-length"]; delete headers["content-type"]; }
        url = next;
        continue;
      }
      const h = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const k = res.rawHeaders[i].toLowerCase();
        if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding") continue;
        h.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      }
      const bytes = decode(raw, res.headers["content-encoding"]);
      const empty = status === 204 || status === 205 || status === 304 || method === "HEAD";
      const out = new Response(empty ? null : bytes, { status, statusText: res.statusMessage, headers: h });
      Object.defineProperty(out, "url", { value: url.href });
      return out;
    }
  };

  globalThis.fetch = guardedFetch;
  delete globalThis.WebSocket;
  delete globalThis.EventSource;
  delete globalThis.XMLHttpRequest;
  // (Node keeps undici's dispatcher on a non-deletable global symbol, but it is only filled in when the built-in fetch runs, which nothing here calls.)
  // The child shares a user with the server; without this a function could signal it.
  process.kill = () => { throw new Error("process.kill is not available in functions"); };
  process.getBuiltinModule = undefined;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isBuiltin(specifier)) {
        const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
        if (!SAFE.has(bare)) throw new Error(`the module ${specifier} is not available in functions`);
      }
      return nextResolve(specifier, context);
    },
  });
}
