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

export type GatewayOptions = {
  domain: string;
  hooks?: GatewayHooks;
  /** A project's settings, for per-project CORS. Without it every origin is allowed. */
  settingsFor?: (ref: string) => Promise<Record<string, unknown> | null | undefined>;
  /** Origins that are always allowed even when a project restricts them, such as the dashboard that manages the project. */
  alwaysAllow?: string[];
};

/** Does an allowed-origin entry match this origin? Exact (case-insensitive), "*" for everything, or a subdomain wildcard like https://*.example.com. */
export function originMatches(pattern: string, origin: string): boolean {
  const p = pattern.trim().toLowerCase();
  const o = origin.toLowerCase();
  if (p === "*") return true;
  if (!p.includes("*")) return p === o;
  const m = /^(https?):\/\/\*\.([a-z0-9.-]+(?::\d+)?)$/.exec(p);
  if (!m) return false;
  const rest = m[2]!.replace(/\./g, "\\.");
  return new RegExp(`^${m[1]}://[a-z0-9-]+(\\.[a-z0-9-]+)*\\.${rest}$`).test(o);
}

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

  /**
   * Browsers only read a cross-origin response if the server says so. With no cors_origins set, any origin may (the default for an API
   * used from many sites). With a list, only those origins (and the dashboard) get the permission; others are simply not granted it.
   * This protects users' browsers; it does not stop a server or script from calling the API, which an API key governs.
   */
  async function corsHeaders(req: FastifyRequest): Promise<Record<string, string>> {
    const out: Record<string, string> = { ...CORS };
    const ref = refFromHost(req.headers.host, opts.domain);
    const settings = ref && opts.settingsFor ? await opts.settingsFor(ref).catch(() => null) : null;
    const list = Array.isArray(settings?.cors_origins) ? (settings!.cors_origins as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
    if (!list.length) return out;
    delete out["access-control-allow-origin"];
    out.vary = "Origin";
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (origin && ((opts.alwaysAllow ?? []).some((x) => x.toLowerCase() === origin.toLowerCase()) || list.some((x) => originMatches(x, origin)))) out["access-control-allow-origin"] = origin;
    return out;
  }

  app.setErrorHandler(async (err: Error & { statusCode?: number }, req, reply) => {
    reply.headers(await corsHeaders(req));
    if (err instanceof AuthError) return reply.code(err.status).send({ code: err.status, error_code: err.errorCode, msg: err.message });
    if (err instanceof HttpError) return reply.headers(err.headers ?? {}).code(err.status).send({ message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ message: err.message });
    // Malformed input that reached the database (bad bytes, out-of-range values) is the caller's mistake, not ours.
    if (/^22/.test((err as { code?: string }).code ?? "")) return reply.code(400).send({ message: "invalid input" });
    return reply.code(500).send({ message: "internal error" });
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.headers(await corsHeaders(req));
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

  authRoute("GET", "/settings", async (ctx) => A.publicSettings(ctx.project));
  const redirectParam = (req: FastifyRequest) => (req.query as Record<string, string>).redirect_to;
  authRoute("POST", "/signup", (ctx, req) => A.signup(ctx.ref, ctx.project, jsonBody(req), redirectParam(req)));
  authRoute("POST", "/token", (ctx, req) => {
    const grant = (req.query as Record<string, string>).grant_type;
    if (grant === "password") return A.passwordLogin(ctx.ref, ctx.project, jsonBody(req));
    if (grant === "refresh_token") return A.refresh(ctx.ref, ctx.project, jsonBody(req));
    throw new AuthError(400, "unsupported_grant_type", "grant_type must be password or refresh_token");
  });
  authRoute("GET", "/user", (ctx) => A.me(ctx.ref, ctx.project, ctx.who.claims));
  authRoute("PUT", "/user", (ctx, req) => A.updateMe(ctx.ref, ctx.project, ctx.who.claims, jsonBody(req)));
  authRoute("POST", "/logout", async (ctx) => {
    await A.logout(ctx.ref, ctx.who.claims);
  }, { status: 204 });
  // Multi-factor authentication: enrol an authenticator app, then answer a challenge with its code to upgrade the session to aal2.
  authRoute("POST", "/factors", (ctx, req) => A.mfaEnroll(ctx.ref, ctx.project, ctx.who.claims, jsonBody(req)), { status: 200 });
  app.route({
    method: ["POST", "DELETE"], url: "/auth/v1/factors/:id/:action",
    handler: async (req, reply) =>
      withCtx(req, reply, async (ctx) => {
        const { id, action } = req.params as { id: string; action: string };
        if (req.method === "POST" && action === "challenge") return reply.send(await A.mfaChallenge(ctx.ref, ctx.project, ctx.who.claims, id));
        if (req.method === "POST" && action === "verify") return reply.send(await A.mfaVerify(ctx.ref, ctx.project, ctx.who.claims, id, jsonBody(req)));
        throw new HttpError(404, "not found");
      }),
  });
  app.delete("/auth/v1/factors/:id", (req, reply) =>
    withCtx(req, reply, async (ctx) => reply.send(await A.mfaUnenroll(ctx.ref, ctx.project, ctx.who.claims, (req.params as { id: string }).id))));
  authRoute("POST", "/recover", (ctx, req) => A.recover(ctx.ref, ctx.project, jsonBody(req), redirectParam(req)));
  authRoute("POST", "/magiclink", (ctx, req) => A.magicLink(ctx.ref, ctx.project, jsonBody(req), redirectParam(req)));
  authRoute("POST", "/otp", (ctx, req) => A.magicLink(ctx.ref, ctx.project, jsonBody(req), redirectParam(req)));
  authRoute("POST", "/resend", (ctx, req) => A.resend(ctx.ref, ctx.project, jsonBody(req), redirectParam(req)));

  // Pages the browser lands on from an email or from a provider. They carry no API key, so they resolve the project from the host alone.
  const fragment = (s: { access_token: string; refresh_token: string; expires_at: number; expires_in: number }, type: string) =>
    new URLSearchParams({ access_token: s.access_token, expires_at: String(s.expires_at), expires_in: String(s.expires_in), refresh_token: s.refresh_token, token_type: "bearer", type }).toString();
  const sendHtml = (reply: FastifyReply, status: number, title: string, message: string) =>
    reply.code(status).header("content-type", "text/html; charset=utf-8").header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1>${title}</h1><p>${message}</p></body>`);
  const goBack = (to: string, params: Record<string, string>, asFragment: string | null) => {
    const u = new URL(to);
    if (asFragment !== null) u.hash = asFragment;
    else for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const failBack = (err: AuthError & { redirectTo?: string | null }, reply: FastifyReply) => {
    if (err.redirectTo) {
      const params = { error: err.errorCode, error_code: err.errorCode, error_description: err.message };
      const u = new URL(err.redirectTo);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      u.hash = new URLSearchParams(params).toString();
      return reply.code(302).header("location", u.toString()).send("");
    }
    return sendHtml(reply, err.status >= 400 ? err.status : 400, "Sign-in failed", err.message.replace(/[<>&"]/g, ""));
  };
  app.get("/auth/v1/verify", (req, reply) =>
    withCtx(req, reply, async (ctx) => {
      const q = req.query as Record<string, string>;
      try {
        const r = await A.verify(ctx.ref, ctx.project, { token: q.token, type: q.type });
        if (r.redirectTo) return reply.code(302).header("location", goBack(r.redirectTo, {}, fragment(r.session, r.type))).send("");
        return sendHtml(reply, 200, r.type === "signup" ? "Email confirmed" : "Signed in", r.type === "recovery" ? "You can now choose a new password in the app." : "You can close this tab and return to the app.");
      } catch (e) {
        if (e instanceof AuthError) return sendHtml(reply, e.status, "This link did not work", "The link is invalid, has expired or was already used. Ask for a new one.");
        throw e;
      }
    }, { anonymous: true }));
  app.post("/auth/v1/verify", (req, reply) =>
    withCtx(req, reply, async (ctx) => {
      const b = jsonBody(req);
      const r = await A.verify(ctx.ref, ctx.project, { token: b.token ?? b.token_hash, type: b.type, email: b.email });
      return reply.send(r.session);
    }, { anonymous: true }));
  app.get("/auth/v1/authorize", (req, reply) =>
    withCtx(req, reply, async (ctx) => {
      const q = req.query as Record<string, string>;
      const { url, nonce } = await A.authorize(ctx.ref, ctx.project, q.provider, q.redirect_to);
      return reply.header("set-cookie", `baas_oauth=${nonce}; HttpOnly; SameSite=Lax; Path=/auth/v1; Max-Age=600${A.secureCookies ? "; Secure" : ""}`).code(302).header("location", url).send("");
    }, { anonymous: true }));
  app.get("/auth/v1/callback", (req, reply) =>
    withCtx(req, reply, async (ctx) => {
      const cookie = /(?:^|;\s*)baas_oauth=([\w-]+)/.exec(String(req.headers.cookie ?? ""))?.[1];
      try {
        const r = await A.callback(ctx.ref, ctx.project, req.query as Record<string, string>, cookie);
        reply.header("set-cookie", `baas_oauth=; HttpOnly; SameSite=Lax; Path=/auth/v1; Max-Age=0${A.secureCookies ? "; Secure" : ""}`);
        if (!r.redirectTo) return sendHtml(reply, 200, "Signed in", "You can close this tab and return to the app.");
        return reply.code(302).header("location", goBack(r.redirectTo, {}, fragment(r.session, "oauth"))).send("");
      } catch (e) {
        if (e instanceof AuthError) return failBack(e as AuthError & { redirectTo?: string | null }, reply);
        throw e;
      }
    }, { anonymous: true }));
  authRoute("GET", "/admin/users", (ctx, req) => {
    const q = req.query as Record<string, string>;
    return A.adminList(ctx.ref, ctx.project, Math.max(1, Number(q.page) || 1), Math.min(200, Math.max(1, Number(q.per_page) || 50)));
  }, { serviceOnly: true });
  authRoute("POST", "/admin/users", (ctx, req) => A.adminCreate(ctx.ref, jsonBody(req)), { serviceOnly: true, status: 201 });
  app.delete("/auth/v1/admin/users/:id/factors", (req, reply) =>
    withCtx(req, reply, async (ctx) => {
      if (ctx.who.role !== "service_role") throw new AuthError(403, "not_admin", "User not allowed");
      await A.adminRemoveFactors(ctx.ref, ctx.project, (req.params as { id: string }).id);
      return reply.code(204).send();
    }));
  app.delete("/auth/v1/admin/users/:id/factors/:fid", (req, reply) =>
    withCtx(req, reply, async (ctx) => {
      if (ctx.who.role !== "service_role") throw new AuthError(403, "not_admin", "User not allowed");
      const p = req.params as { id: string; fid: string };
      await A.adminRemoveFactors(ctx.ref, ctx.project, p.id, p.fid);
      return reply.code(204).send();
    }));
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
