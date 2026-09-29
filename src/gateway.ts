import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { AuthError, type AuthService } from "./authsvc.js";
import { HttpError, type Resolved } from "./control.js";
import { verifyJwt, type Claims } from "./keys.js";
import { API_ROLES, type ApiRole, type PoolManager } from "./pools.js";
import { handleRest } from "./rest.js";

export type Principal = { role: ApiRole; claims: Claims };
export type ProjectCtx = { ref: string; project: Resolved & { secrets: NonNullable<Resolved["secrets"]> }; who: Principal };

declare module "fastify" {
  interface FastifyRequest {
    ctx?: ProjectCtx;
    projectRef?: string;
  }
}

/** Optional cross-cutting hooks the ops layer plugs in (metering, quotas, rate limiting, logs). */
export interface GatewayHooks {
  /** Throw an HttpError (e.g. 429) to reject the request before it reaches a service. */
  admit?(ref: string, project: Resolved, req: FastifyRequest): void | Promise<void>;
  done?(ref: string, req: FastifyRequest, status: number, bytesOut: number, ms: number): void;
}

/** Modules mounted under /<service>/v1. Each is handed the resolved project and caller. */
export type Helpers = {
  authenticate(req: FastifyRequest, o?: { anonymous?: boolean }): Promise<ProjectCtx>;
  withCtx(req: FastifyRequest, reply: FastifyReply, fn: (ctx: ProjectCtx) => Promise<unknown>, o?: { anonymous?: boolean }): Promise<unknown>;
};

export interface Mountable {
  mount(app: FastifyInstance, h: Helpers): void;
}

export interface GatewayServices {
  auth: AuthService;
  storage?: Mountable;
  functions?: Mountable;
  realtime?: Mountable;
}

export type GatewayOptions = { domain: string; hooks?: GatewayHooks };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, prefer, range, accept-profile, content-profile, x-upsert, accept, cache-control, x-supabase-api-version",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
  "access-control-expose-headers": "content-range, content-length, etag",
  "access-control-max-age": "86400",
};

const REF_HOST = /^([a-z0-9]{20})\.(.+)$/;

export function refFromHost(hostHeader: string | undefined, domain: string): string | null {
  const host = (hostHeader ?? "").toLowerCase().replace(/:\d+$/, "");
  const m = REF_HOST.exec(host);
  return m && m[2] === domain.toLowerCase() ? m[1]! : null;
}

export function jsonBody(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (!b || (b as Buffer).length === 0) return {};
  try {
    const v = JSON.parse((b as Buffer).toString("utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function buildGateway(pm: PoolManager, services: GatewayServices, opts: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 52_428_800, trustProxy: false });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(/.*/, { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.headers(CORS);
    if (err instanceof AuthError) return reply.code(err.status).send({ code: err.status, error_code: err.errorCode, msg: err.message });
    if (err instanceof HttpError) return reply.headers(err.headers ?? {}).code(err.status).send({ message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ message: err.message });
    // Malformed input that reached the database (bad bytes, out-of-range values) is the caller's mistake, not ours.
    if (/^22/.test((err as { code?: string }).code ?? "")) return reply.code(400).send({ message: "invalid input" });
    return reply.code(500).send({ message: "internal error" });
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.headers(CORS);
    if (req.method === "OPTIONS") return reply.code(204).send();
    if (req.url === "/healthz") return;
    const ref = refFromHost(req.headers.host, opts.domain);
    if (!ref) return reply.code(404).send({ message: "unknown host" });
    // Two Host headers are ambiguous when a proxy sits in front, so refuse them instead of guessing.
    let hosts = 0;
    for (let i = 0; i < req.raw.rawHeaders.length; i += 2) if (req.raw.rawHeaders[i]!.toLowerCase() === "host") hosts++;
    if (hosts > 1) return reply.code(400).send({ message: "multiple Host headers" });
    req.projectRef = ref;
    (req as unknown as { t0: number }).t0 = Date.now();
  });

  app.addHook("onSend", async (req, reply, payload) => {
    (req as unknown as { bytes: number }).bytes =
      typeof payload === "string" || Buffer.isBuffer(payload) ? Buffer.byteLength(payload) : Number(reply.getHeader("content-length") ?? 0);
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    if (req.projectRef)
      opts.hooks?.done?.(req.projectRef, req, reply.statusCode, (req as unknown as { bytes?: number }).bytes ?? 0, Date.now() - (req as unknown as { t0: number }).t0);
  });

  app.get("/healthz", async () => ({ ok: true }));
  // Lets non-HTTP handlers (WebSocket upgrades) resolve the project the same way.
  app.decorate("refFromHost", (h?: string) => refFromHost(h, opts.domain));

  /** Resolve the project and who is calling. Throws 404/503 for the project and 401 for bad credentials. */
  async function authenticate(req: FastifyRequest, opts2: { anonymous?: boolean } = {}): Promise<ProjectCtx> {
    const ref = req.projectRef!;
    const project = await pm.active(ref);
    await opts.hooks?.admit?.(ref, project, req);
    const secret = project.secrets.jwtSecret;
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const apikey = (req.headers.apikey as string | undefined) ?? ((req.query as Record<string, string>)?.apikey);
    let claims: Claims | null = null;
    if (bearer) {
      claims = verifyJwt(bearer, secret);
      if (!claims) throw new HttpError(401, "invalid or expired JWT");
    } else if (apikey) {
      claims = verifyJwt(apikey, secret);
      if (!claims) throw new HttpError(401, "invalid API key");
    } else if (opts2.anonymous) {
      // Public routes (public buckets, signed URLs) work without credentials; they never act as a database role.
      claims = { role: "anon", exp: Math.floor(Date.now() / 1000) + 60 };
    } else throw new HttpError(401, "No API key found in request");
    if (!API_ROLES.has(claims.role)) throw new HttpError(401, "unsupported role in JWT");
    if (claims.role === "authenticated" && (typeof claims.sub !== "string" || !/^[0-9a-f-]{36}$/.test(claims.sub))) throw new HttpError(401, "user JWT is missing sub");
    return { ref, project, who: { role: claims.role as ApiRole, claims } };
  }

  async function withCtx(req: FastifyRequest, reply: FastifyReply, fn: (ctx: ProjectCtx) => Promise<unknown>, o?: { anonymous?: boolean }) {
    const ctx = await authenticate(req, o);
    req.ctx = ctx;
    return fn(ctx);
  }

  const rest = async (req: FastifyRequest, reply: FastifyReply) =>
    withCtx(req, reply, async (ctx) => {
      const r = await handleRest(pm, {
        ref: ctx.ref, role: ctx.who.role, claims: ctx.who.claims, method: req.method,
        path: (req.params as { "*": string })["*"] ?? "", query: req.query as Record<string, string | string[]>,
        headers: req.headers, body: req.body as Buffer | undefined,
      });
      return reply.code(r.status).headers(r.headers).send(r.body);
    });
  app.all("/rest/v1", rest);
  app.all("/rest/v1/*", rest);

  // ---- auth ----
  const A = services.auth;
  const authRoute = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, fn: (ctx: ProjectCtx, req: FastifyRequest) => Promise<unknown>, o?: { status?: number; serviceOnly?: boolean }) =>
    app.route({
      method,
      url: `/auth/v1${path}`,
      handler: async (req, reply) =>
        withCtx(req, reply, async (ctx) => {
          if (o?.serviceOnly && ctx.who.role !== "service_role") throw new AuthError(403, "not_admin", "User not allowed");
          const out = await fn(ctx, req);
          return reply.code(o?.status ?? 200).send(out === undefined ? "" : out);
        }),
    });

  authRoute("GET", "/settings", async (ctx) => ({
    external: { email: true }, disable_signup: ctx.project.settings.disable_signup === true, mailer_autoconfirm: true,
  }));
  authRoute("POST", "/signup", (ctx, req) => A.signup(ctx.ref, ctx.project, jsonBody(req)));
  authRoute("POST", "/token", (ctx, req) => {
    const grant = (req.query as Record<string, string>).grant_type;
    if (grant === "password") return A.passwordLogin(ctx.ref, ctx.project, jsonBody(req));
    if (grant === "refresh_token") return A.refresh(ctx.ref, ctx.project, jsonBody(req));
    throw new AuthError(400, "unsupported_grant_type", "grant_type must be password or refresh_token");
  });
  authRoute("GET", "/user", (ctx) => A.me(ctx.ref, ctx.who.claims));
  authRoute("PUT", "/user", (ctx, req) => A.updateMe(ctx.ref, ctx.who.claims, jsonBody(req)));
  authRoute("POST", "/logout", async (ctx) => {
    await A.logout(ctx.ref, ctx.who.claims);
  }, { status: 204 });
  for (const p of ["/recover", "/otp", "/magiclink", "/verify", "/resend"])
    authRoute("POST", p, async () => {
      throw new AuthError(501, "not_implemented", "Email delivery is not configured for this platform");
    });
  authRoute("GET", "/admin/users", (ctx, req) => {
    const q = req.query as Record<string, string>;
    return A.adminList(ctx.ref, Math.max(1, Number(q.page) || 1), Math.min(200, Math.max(1, Number(q.per_page) || 50)));
  }, { serviceOnly: true });
  authRoute("POST", "/admin/users", (ctx, req) => A.adminCreate(ctx.ref, jsonBody(req)), { serviceOnly: true, status: 201 });
  app.route({
    method: ["GET", "PUT", "DELETE"], url: "/auth/v1/admin/users/:id",
    handler: async (req, reply) =>
      withCtx(req, reply, async (ctx) => {
        if (ctx.who.role !== "service_role") throw new AuthError(403, "not_admin", "User not allowed");
        const id = (req.params as { id: string }).id;
        if (req.method === "GET") return reply.send(await A.adminGet(ctx.ref, id));
        if (req.method === "PUT") return reply.send(await A.adminUpdate(ctx.ref, id, jsonBody(req)));
        await A.adminDelete(ctx.ref, id);
        return reply.code(204).send();
      }),
  });

  // ---- optional services ----
  const helpers: Helpers = { authenticate, withCtx };
  services.storage?.mount(app, helpers);
  services.functions?.mount(app, helpers);
  services.realtime?.mount(app, helpers);

  return app;
}
