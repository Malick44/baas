/**
 * A small S3 client: just the calls object storage needs, signed with AWS Signature Version 4, no dependencies.
 * Works with AWS S3 and S3-compatible servers (MinIO, Ceph, Cloudflare R2, Backblaze B2, SeaweedFS...).
 */
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";

export type S3Config = {
  /** Server address, like https://s3.eu-west-1.amazonaws.com or http://minio:9000. */
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** /bucket/key (default, works everywhere) or bucket.host/key (what AWS prefers). */
  pathStyle?: boolean;
  /** Prepended to every key, so one bucket can serve several installations. */
  prefix?: string;
  fetch?: typeof fetch;
  /** For known-answer tests. */
  now?: () => Date;
};

export class S3Error extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** Percent-encode the way SigV4 wants: everything except unreserved characters (and "/" when it separates path segments). */
export const awsEncode = (s: string, keepSlash = false) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%2F/g, keepSlash ? "/" : "%2F");

export type SignInput = {
  method: string;
  /** Path already encoded with awsEncode, starting with "/". */
  path: string;
  query?: Record<string, string>;
  host: string;
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
  service?: string;
};

/** The headers to send, including Authorization. */
export function signV4(i: SignInput): Record<string, string> {
  const amz = i.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amz.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(i.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")])), host: i.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": amz };
  const names = Object.keys(headers).sort();
  const canonicalQuery = Object.entries(i.query ?? {}).map(([k, v]) => [awsEncode(k), awsEncode(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  // Each header line ends with a newline, and a blank line separates the headers from the list of their names.
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const canonical = `${i.method}\n${i.path}\n${canonicalQuery}\n${canonicalHeaders}\n${names.join(";")}\n${i.payloadHash}`;
  const scope = `${day}/${i.region}/${i.service ?? "s3"}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, sha256hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), i.service ?? "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _h, ...send } = headers;
  return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** Undo XML escaping, including numeric references (&#39; and &#x27;), which some servers use. */
const unxml = (s: string) =>
  s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class S3 {
  private url: URL;
  private f: typeof fetch;
  constructor(private cfg: S3Config) {
    this.url = new URL(cfg.endpoint);
    if (!/^https?:$/.test(this.url.protocol)) throw new Error("the S3 endpoint must start with http:// or https://");
    if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) throw new Error("S3 needs a bucket, an access key id and a secret access key");
    this.f = cfg.fetch ?? fetch;
  }

  private get region() {
    return this.cfg.region ?? "us-east-1";
  }

  private target(key: string | null, query: Record<string, string> = {}) {
    const pathStyle = this.cfg.pathStyle !== false;
    const host = pathStyle ? this.url.host : `${this.cfg.bucket}.${this.url.host}`;
    const k = key === null ? "" : `${this.cfg.prefix ?? ""}${key}`;
    const path = pathStyle ? `/${awsEncode(this.cfg.bucket)}${k ? `/${awsEncode(k, true)}` : ""}` : `/${awsEncode(k, true)}`;
    const q = Object.entries(query).sort(([a], [b]) => (a < b ? -1 : 1)).map(([a, b]) => `${awsEncode(a)}=${awsEncode(b)}`).join("&");
    return { host, path: path === "" ? "/" : path, query, url: `${this.url.protocol}//${host}${path}${q ? `?${q}` : ""}` };
  }

  private async call(method: string, key: string | null, o: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string>; stream?: boolean; ok?: number[] } = {}): Promise<Response> {
    const t = this.target(key, o.query);
    const body = o.body ?? Buffer.alloc(0);
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = signV4({ method, path: t.path, query: o.query, host: t.host, headers: { ...(o.headers ?? {}), ...(o.body ? { "content-length": String(body.length) } : {}) }, payloadHash: sha256hex(body), region: this.region, accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, date: this.cfg.now?.() ?? new Date() });
      delete headers["content-length"]; // fetch sets it itself
      try {
        const res = await this.f(t.url, { method, headers, body: o.body && method !== "GET" ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(o.stream ? 60_000 : 30_000) });
        if (res.status >= 500 && attempt < 2) { await res.arrayBuffer().catch(() => {}); await new Promise((r) => setTimeout(r, 200 * 2 ** attempt)); continue; }
        if (!res.ok && !(o.ok ?? []).includes(res.status)) {
          const text = await res.text().catch(() => "");
          throw new S3Error(res.status, /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? String(res.status), `S3 ${method} ${key ?? "bucket"} failed: ${res.status} ${/<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? ""} ${unxml(/<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? "")}`.trim());
        }
        return res;
      } catch (e) {
        if (e instanceof S3Error) throw e;
        last = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      }
    }
    throw new S3Error(0, "Unreachable", `could not reach the S3 server: ${(last as Error)?.message ?? last}`);
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    await this.call("PUT", key, { body: data, headers: contentType ? { "content-type": contentType } : {} });
  }

  /** The object as a stream, or null when it does not exist. */
  async get(key: string): Promise<{ stream: Readable; size: number } | null> {
    const res = await this.call("GET", key, { stream: true, ok: [404] });
    if (res.status === 404) return null;
    return { stream: Readable.fromWeb(res.body as never), size: Number(res.headers.get("content-length") ?? 0) };
  }

  async exists(key: string): Promise<boolean> {
    return (await this.call("HEAD", key, { ok: [404] })).status !== 404;
  }

  async delete(key: string): Promise<void> {
    await this.call("DELETE", key, { ok: [404] });
  }

  async copy(from: string, to: string): Promise<void> {
    const source = `/${awsEncode(this.cfg.bucket)}/${awsEncode(`${this.cfg.prefix ?? ""}${from}`, true)}`;
    const res = await this.call("PUT", to, { headers: { "x-amz-copy-source": source } });
    // S3 can answer 200 and still report an error in the body.
    const text = await res.text();
    if (/<Error>/.test(text)) throw new S3Error(500, /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? "CopyFailed", "S3 copy failed");
  }

  /** Every key under a prefix (without our own prefix), following continuation tokens. */
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token = "";
    for (;;) {
      const res = await this.call("GET", null, { query: { "list-type": "2", prefix: `${this.cfg.prefix ?? ""}${prefix}`, ...(token ? { "continuation-token": token } : {}) } });
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) out.push(unxml(m[1]!).slice((this.cfg.prefix ?? "").length));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") : "";
      if (!token) return out;
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const body = Buffer.from(`<Delete><Quiet>true</Quiet>${keys.slice(i, i + 1000).map((k) => `<Object><Key>${xmlEsc(`${this.cfg.prefix ?? ""}${k}`)}</Key></Object>`).join("")}</Delete>`);
      // DeleteObjects insists on a Content-MD5 of the body.
      const res = await this.call("POST", null, { query: { delete: "" }, body, headers: { "content-md5": createHash("md5").update(body).digest("base64"), "content-type": "application/xml" } });
      const xml = await res.text();
      if (/<Error>/.test(xml)) throw new S3Error(500, /<Code>([^<]*)<\/Code>/.exec(xml)?.[1] ?? "DeleteFailed", `S3 could not delete some objects: ${unxml(/<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? "")}`);
    }
  }

  /** Is the bucket there, and may we use it? */
  async check(): Promise<void> {
    await this.call("HEAD", null);
  }

  async createBucket(): Promise<void> {
    await this.call("PUT", null, { ok: [409] });
  }
}
