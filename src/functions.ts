import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "./control.js";
import type { ControlPlane } from "./control.js";
import { type Helpers, type Mountable } from "./gateway.js";
import { FunctionError, runFunction } from "./sandbox.js";

export type LogEntry = { at: string; name: string; status: number; ms: number; note?: string };
export type FunctionOptions = {
  /** Public origin of a project, e.g. http://<ref>.localhost:8081, given to functions as SUPABASE_URL. */
  publicUrl: (ref: string) => string;
  timeoutMs?: number;
  /** What functions may reach over the network: "public" (default) refuses private and local addresses, "open" does not restrict. A project's own URL is always allowed. */
  egress?: "public" | "open" | "off";
  /** Extra host:port destinations functions may reach even if they are on a private network. */
  egressAllow?: string[];
  perProject?: number;
  global?: number;
};

const SKIP_REQ_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "expect", "upgrade"]);
const SKIP_RES_HEADERS = new Set(["connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "set-cookie"]);

export class FunctionService implements Mountable {
  private running = new Map<string, number>();
  private total = 0;
  private logs = new Map<string, LogEntry[]>();

  constructor(private control: ControlPlane, private opts: FunctionOptions) {}

  logsFor(ref: string, name?: string): LogEntry[] {
    return (this.logs.get(ref) ?? []).filter((l) => !name || l.name === name);
  }

  private log(ref: string, e: Omit<LogEntry, "at">) {
    const list = this.logs.get(ref) ?? [];
    list.push({ at: new Date().toISOString(), ...e });
    if (list.length > 200) list.shift();
    this.logs.set(ref, list);
    if (this.logs.size > 1000) this.logs.delete(this.logs.keys().next().value!);
  }

  mount(app: FastifyInstance, { authenticate }: Helpers): void {
    const handler = async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
      const name = (req.params as { name: string }).name;
      const ref = req.projectRef!;
      const fn = /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) ? await this.control.functionSource(ref, name) : null;
      // Authenticate first only when the project exists; unknown functions 404 either way.
      const ctx = await authenticate(req, { anonymous: fn ? !fn.verify_jwt : true });
      if (!fn) throw new HttpError(404, "function not found");
      if (fn.verify_jwt && ctx.who.role === "anon" && !req.headers.authorization && !req.headers.apikey) throw new HttpError(401, "missing authorization");

      const limit = this.opts.perProject ?? 4;
      if ((this.running.get(ref) ?? 0) >= limit || this.total >= (this.opts.global ?? 16)) throw new HttpError(429, "too many concurrent function invocations");
      this.running.set(ref, (this.running.get(ref) ?? 0) + 1);
      this.total++;
      const t0 = Date.now();
      try {
        const env: Record<string, string> = {
          SUPABASE_URL: this.opts.publicUrl(ref),
          SUPABASE_ANON_KEY: ctx.project.secrets.anonKey,
          SUPABASE_SERVICE_ROLE_KEY: ctx.project.secrets.serviceKey,
          ...((ctx.project.settings.function_env as Record<string, string> | undefined) ?? {}),
        };
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !SKIP_REQ_HEADERS.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        const url = `${this.opts.publicUrl(ref)}${req.url}`;
        const out = await runFunction({
          ref, name, version: fn.version, source: fn.source, method: req.method, url, headers,
          body: (req.body as Buffer | undefined) ?? Buffer.alloc(0), env, timeoutMs: this.opts.timeoutMs ?? 10_000,
          egress: { mode: this.opts.egress ?? "public", allow: [new URL(this.opts.publicUrl(ref)).host, ...(this.opts.egressAllow ?? [])] },
        });
        for (const [k, v] of out.headers) if (!SKIP_RES_HEADERS.has(k.toLowerCase())) reply.header(k, v);
        this.log(ref, { name, status: out.status, ms: Date.now() - t0 });
        return reply.code(out.status).send(out.body);
      } catch (err) {
        if (err instanceof FunctionError) {
          this.log(ref, { name, status: err.kind === "timeout" ? 504 : 500, ms: Date.now() - t0, note: `${err.message}${err.stderr ? `: ${err.stderr.split("\n").filter((l) => /error/i.test(l)).slice(0, 2).join(" | ").slice(0, 400)}` : ""}` });
          throw new HttpError(err.kind === "timeout" ? 504 : 500, err.kind === "timeout" ? "function timed out" : "function error");
        }
        throw err;
      } finally {
        this.running.set(ref, (this.running.get(ref) ?? 1) - 1);
        this.total--;
      }
    };
    app.all("/functions/v1/:name", handler);
    app.all("/functions/v1/:name/*", handler);
  }
}
