// Runs inside the sandboxed child process. Reads one invocation from stdin, writes one result to stdout.
import { pathToFileURL } from "node:url";

const MAX_OUT = 6 * 1024 * 1024;
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

// Some platforms inject child-process variables even when the parent passes an empty environment.
for (const k of Object.keys(process.env)) delete process.env[k];
for (const [k, v] of Object.entries(input.env)) process.env[k] = v;

// Narrow what the function can reach before it is loaded. "open" keeps fetch unrestricted but still removes the escape hatches.
if (input.egress && input.egress.mode !== "off") (await import(pathToFileURL(input.egressGuard).href)).installEgressGuard(input.egress);

const mod = await import(pathToFileURL(input.file).href);
const handler = mod.default ?? mod.handler;
if (typeof handler !== "function") throw new Error("function must export a default handler");

const hasBody = !["GET", "HEAD"].includes(input.method);
const request = new Request(input.url, {
  method: input.method,
  headers: input.headers,
  body: hasBody ? Buffer.from(input.body, "base64") : undefined,
});
const res = await handler(request);
if (!(res instanceof Response)) throw new Error("handler must return a Response");
const body = Buffer.from(await res.arrayBuffer());
if (body.length > MAX_OUT) throw new Error("response too large");
process.stdout.write(JSON.stringify({ status: res.status, headers: [...res.headers], body: body.toString("base64") }));
