import { spawn } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs untrusted function code in a child Node process under the permission model:
 * no filesystem beyond the function's own file, no subprocesses, no workers, no native addons,
 * an empty environment, a heap cap and a wall-clock kill.
 *
 * NOT restricted: outbound network access. Node 22 cannot limit it, so a function can reach anything
 * this host can. Production deployments should run this on a host with no route to internal services,
 * or replace this module with a Deno/gVisor/Firecracker runner behind the same interface.
 */

const RUNNER = fileURLToPath(new URL("./function-runner.mjs", import.meta.url));
const MAX_STDOUT = 8 * 1024 * 1024;

let rootPromise: Promise<string> | undefined;
const root = () => (rootPromise ??= mkdtemp(join(tmpdir(), "baas-fn-")));

export type Invocation = {
  ref: string;
  name: string;
  version: number;
  source: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  env: Record<string, string>;
  timeoutMs: number;
  memoryMb?: number;
};
export type Result = { status: number; headers: [string, string][]; body: Buffer };

export class FunctionError extends Error {
  constructor(readonly kind: "timeout" | "crash" | "output", message: string, readonly stderr = "") {
    super(message);
  }
}

async function materialise(inv: Pick<Invocation, "ref" | "name" | "version" | "source">): Promise<string> {
  const dir = join(await root(), inv.ref);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${inv.name}.${inv.version}.mjs`);
  await stat(file).catch(() => writeFile(file, inv.source, { mode: 0o600 }));
  return file;
}

/** Parse-check a module without running it. Returns an error message, or null when the syntax is valid. */
export async function checkSyntax(source: string): Promise<string | null> {
  const dir = join(await root(), "_check");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, source);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--permission", `--allow-fs-read=${file}`, "--check", file], { env: {}, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve(code === 0 ? null : (err.split("\n").find((l) => /Error/.test(l)) ?? "syntax error").slice(0, 300)));
  });
}

export async function runFunction(inv: Invocation): Promise<Result> {
  const file = await materialise(inv);
  const child = spawn(
    process.execPath,
    ["--permission", `--allow-fs-read=${file}`, `--allow-fs-read=${RUNNER}`, `--max-old-space-size=${inv.memoryMb ?? 128}`, RUNNER],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  return new Promise<Result>((resolve, reject) => {
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new FunctionError("timeout", `function exceeded ${inv.timeoutMs}ms`)));
    }, inv.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > MAX_STDOUT) {
        child.kill("SIGKILL");
        finish(() => reject(new FunctionError("output", "function output too large")));
      } else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 4096) err += d.toString();
    });
    child.on("error", (e) => finish(() => reject(new FunctionError("crash", e.message))));
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0) return reject(new FunctionError("crash", `function exited with code ${code}`, err));
        try {
          const r = JSON.parse(Buffer.concat(out).toString("utf8")) as { status: number; headers: [string, string][]; body: string };
          resolve({ status: r.status, headers: r.headers, body: Buffer.from(r.body, "base64") });
        } catch {
          reject(new FunctionError("crash", "function produced no valid response", err));
        }
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ file, method: inv.method, url: inv.url, headers: inv.headers, body: inv.body.toString("base64"), env: inv.env }));
  });
}
