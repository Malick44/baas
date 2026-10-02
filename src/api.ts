import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { ProjectAdmin } from "./admin-sql.js";
import type { AiAssistant } from "./ai/assistant.js";
import type { BackupService } from "./backup.js";
import { ControlPlane, HttpError, type Principal, type ProjectRow, type Role } from "./control.js";
import type { AuthService } from "./authsvc.js";
import type { ExtensionService } from "./extensions.js";
import type { FunctionService } from "./functions.js";
import type { PipelineService } from "./pipelines.js";
import { DEFAULT_TEMPLATES } from "./mailer.js";
import { Members } from "./members.js";
import { PROVIDERS } from "./oauth.js";
import { PLANS, planOf } from "./plans.js";
import type { Mailer } from "./mailer.js";
import type { UsageService } from "./usage.js";
import type { Vault } from "./vault.js";

/** Optional platform services the management API exposes. Each route group is mounted only if its service is given. */
export type ApiOps = {
  admin?: ProjectAdmin;
  usage?: UsageService;
  backups?: BackupService;
  functions?: FunctionService;
  ai?: AiAssistant;
  pipelines?: PipelineService;
  extensions?: ExtensionService;
  auth?: AuthService;
  /** Where the data plane listens, so clients can build <ref>.<domain> URLs. */
  gateway?: { domain: string; scheme: string; port: number | null };
  /** Hostname the dashboard is served on behind a proxy; certificates may be issued for it too. */
  dashboardHost?: string;
  /** For sealing authenticator secrets. */
  vault?: Vault;
  /** Sends members' password reset emails. */
  mailer?: Mailer;
  /** Public address of the dashboard, for links in emails (for example https://baas.example.com). */
  dashboardUrl?: string;
  /** Directory holding the dashboard's static files. */
  dashboardDir?: string;
};

const ROLES: Role[] = ["developer", "admin", "owner"];

const view = (p: ProjectRow) => ({
  ref: p.ref, name: p.name, status: p.status, plan: p.plan, created_at: p.created_at, updated_at: p.updated_at,
});

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "expected a JSON object body");
  return b as Record<string, unknown>;
}

function text(v: unknown, field: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, `${field} must be a non-empty string up to ${max} chars`);
  return v.trim();
}

/** Management API. `bootstrapToken` is the platform-operator secret that creates organisations. */
export function buildApi(control: ControlPlane, bootstrapToken: string, ops: ApiOps = {}): FastifyInstance {
  if (bootstrapToken.length < 24) throw new Error("bootstrap token must be at least 24 characters");
  const app = Fastify({ logger: false });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  const members = new Members(control, { vault: ops.vault, mailer: ops.mailer, dashboardUrl: ops.dashboardUrl });

  const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];

  async function principal(req: FastifyRequest): Promise<Principal> {
    const t = bearer(req);
    const p = t ? await control.authenticate(t) : null;
    if (!p) throw new HttpError(401, "missing or invalid token");
    return p;
  }

  app.post("/v1/organizations", async (req, reply) => {
    const given = Buffer.from(String(req.headers["x-bootstrap-token"] ?? ""));
    const want = Buffer.from(bootstrapToken);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, "invalid bootstrap token");
    const b = body(req);
    const { org, ownerToken } = await control.createOrg(text(b.name, "name"), text(b.slug, "slug", 40));
    // Optionally create the first owner's dashboard account in the same call.
    const owner = b.owner_email !== undefined ? await members.bootstrapOwner(org.id, b.owner_email, b.owner_password, b.owner_name) : undefined;
    return reply.code(201).send({ organization: org, owner_token: ownerToken, ...(owner ? { owner } : {}) });
  });

  // ---- dashboard accounts ----

  app.post("/v1/auth/login", async (req) => {
    const b = body(req);
    return members.login(b.email, b.password);
  });
  app.post("/v1/auth/mfa", async (req) => {
    const b = body(req);
    return members.loginMfa(b.mfa_token, b.code);
  });
  app.post("/v1/auth/forgot", async (req, reply) => {
    await members.forgotPassword(body(req).email);
    return reply.code(202).send({});
  });
  app.post("/v1/auth/reset", async (req, reply) => {
    const b = body(req);
    await members.resetWithToken(b.token, b.password);
    return reply.code(204).send();
  });
  app.post("/v1/me/mfa/enroll", async (req) => members.mfaEnroll(await principal(req)));
  app.post("/v1/me/mfa/verify", async (req) => members.mfaVerify(await principal(req), body(req).code));
  app.post("/v1/me/mfa/disable", async (req, reply) => {
    const b = body(req);
    await members.mfaDisable(await principal(req), b.password, b.code);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>("/v1/members/:id/mfa", async (req, reply) => {
    await members.removeMfaFor(await principal(req), req.params.id);
    return reply.code(204).send();
  });
  app.post("/v1/auth/logout", async (req, reply) => {
    await members.logout(await principal(req));
    return reply.code(204).send();
  });
  app.post("/v1/auth/accept-invite", async (req, reply) => {
    const b = body(req);
    return reply.code(201).send(await members.acceptInvite(b.token, b.password, b.name));
  });
  app.post("/v1/me/password", async (req, reply) => {
    const b = body(req);
    await members.changePassword(await principal(req), b.current_password, b.new_password);
    return reply.code(204).send();
  });
  app.get("/v1/members", async (req) => members.list(await principal(req)));
  app.post("/v1/members/invites", async (req, reply) => {
    const b = body(req);
    return reply.code(201).send(await members.invite(await principal(req), b.email, b.role));
  });
  app.delete<{ Params: { id: string } }>("/v1/members/invites/:id", async (req, reply) => {
    await members.revokeInvite(await principal(req), req.params.id);
    return reply.code(204).send();
  });
  app.patch<{ Params: { id: string } }>("/v1/members/:id", async (req, reply) => {
    await members.setRole(await principal(req), req.params.id, body(req).role);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>("/v1/members/:id", async (req, reply) => {
    await members.remove(await principal(req), req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/v1/members/:id/password", async (req, reply) => {
    await members.setPasswordFor(await principal(req), req.params.id, body(req).password);
    return reply.code(204).send();
  });

  app.post("/v1/tokens", async (req, reply) => {
    const p = await principal(req);
    const b = body(req);
    const role = b.role as Role;
    if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
    return reply.code(201).send({ token: await control.createToken(p, text(b.name, "name"), role) });
  });

  app.delete<{ Params: { id: string } }>("/v1/tokens/:id", async (req, reply) => {
    await control.revokeToken(await principal(req), req.params.id);
    return reply.code(204).send();
  });

  app.post("/v1/projects", async (req, reply) => {
    const p = await principal(req);
    return reply.code(201).send(view(await control.createProject(p, text(body(req).name, "name"))));
  });

  app.get("/v1/projects", async (req) => (await control.listProjects(await principal(req))).map(view));

  app.get<{ Params: { ref: string } }>("/v1/projects/:ref", async (req) => view(await control.getProject(await principal(req), req.params.ref)));

  app.post<{ Params: { ref: string } }>("/v1/projects/:ref/pause", async (req) => view(await control.pauseProject(await principal(req), req.params.ref)));
  app.post<{ Params: { ref: string } }>("/v1/projects/:ref/resume", async (req) => view(await control.resumeProject(await principal(req), req.params.ref)));

  app.delete<{ Params: { ref: string } }>("/v1/projects/:ref", async (req) => view(await control.deleteProject(await principal(req), req.params.ref)));

  app.get<{ Params: { ref: string } }>("/v1/projects/:ref/api-keys", async (req) => control.apiKeys(await principal(req), req.params.ref));

  app.get<{ Params: { ref: string } }>("/v1/projects/:ref/settings", async (req) => control.getSettings(await principal(req), req.params.ref));
  app.patch<{ Params: { ref: string } }>("/v1/projects/:ref/settings", async (req) => {
    const b = body(req);
    if (b.email_confirm === true && ops.auth && !ops.auth.emailConfigured)
      throw new HttpError(400, "Email delivery is not configured on this server, so confirmation emails cannot be sent. Ask the operator to set SMTP_URL.");
    return control.updateSettings(await principal(req), req.params.ref, b);
  });

  /** Everything the dashboard's Authentication settings need in one call. */
  app.get<{ Params: { ref: string } }>("/v1/projects/:ref/auth-config", async (req) => {
    const p = await principal(req);
    const settings = await control.getSettings(p, req.params.ref);
    const g = ops.gateway;
    const base = g ? `${g.scheme}://${req.params.ref}.${g.domain}${g.port ? `:${g.port}` : ""}` : null;
    const given = (settings.auth_providers ?? {}) as Record<string, { enabled?: boolean; client_id?: string; secret_set?: boolean }>;
    return {
      email_delivery: ops.auth ? ops.auth.emailConfigured : false,
      sms_delivery: ops.auth ? ops.auth.smsConfigured : false,
      callback_url: base ? `${base}/auth/v1/callback` : null,
      custom_providers: Object.entries((settings.oidc_providers ?? {}) as Record<string, Record<string, unknown>>).map(([id, v]) => ({ id, label: v.label ?? id, enabled: v.enabled === true, issuer: v.issuer ?? "", client_id: v.client_id ?? "", scopes: v.scopes ?? "openid email profile", secret_set: v.secret_set === true })),
      providers: Object.entries(PROVIDERS).map(([id, v]) => ({ id, label: v.label, enabled: given[id]?.enabled === true, client_id: given[id]?.client_id ?? "", secret_set: given[id]?.secret_set === true })),
      templates: DEFAULT_TEMPLATES,
      settings,
    };
  });

  app.get("/v1/audit-log", async (req) => control.auditLog(await principal(req)));

  app.get("/healthz", async () => ({ ok: true }));

  /**
   * Lets a TLS proxy (Caddy's on-demand certificates) ask "is this a hostname I should get a certificate for?" before it asks Let's Encrypt.
   * Answers 200 only for the dashboard host and for <ref>.<domain> of a project that exists, so strangers cannot make the proxy
   * request certificates for arbitrary names. It reveals only whether a name is served, which the name itself already shows.
   */
  app.get("/v1/tls-check", async (req, reply) => {
    const host = String((req.query as Record<string, string>).domain ?? "").toLowerCase();
    const g = ops.gateway;
    if (host && ops.dashboardHost && host === ops.dashboardHost.toLowerCase()) return reply.code(200).send({ ok: true });
    const m = g ? new RegExp(`^([a-z0-9]{20})\\.${g.domain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).exec(host) : null;
    const project = m ? await control.resolve(m[1]!) : null;
    if (project && project.status !== "deleted" && project.status !== "purged") return reply.code(200).send({ ok: true });
    return reply.code(404).send({ ok: false });
  });

  const refParam = (req: FastifyRequest) => (req.params as { ref: string }).ref;
  /** Authenticate and confirm the project belongs to the caller's organisation and is usable. */
  const owned = async (req: FastifyRequest, min: Role = "developer") => {
    const p = await principal(req);
    ControlPlane.require(p, min);
    const project = await control.getProject(p, refParam(req));
    return { p, project, ref: project.ref };
  };

  app.get("/v1/me", async (req) => {
    const p = await principal(req);
    return { ...(await control.whoami(p)), member: await members.me(p) };
  });
  app.get("/v1/plans", async () => Object.fromEntries(Object.entries(PLANS)));

  app.patch<{ Params: { ref: string } }>("/v1/projects/:ref", async (req) => {
    const p = await principal(req);
    return view(await control.setPlan(p, refParam(req), text(body(req).plan, "plan", 20)));
  });

  // ---- functions ----
  app.get<{ Params: { ref: string } }>("/v1/projects/:ref/functions", async (req) => control.listFunctions(await principal(req), refParam(req)));
  app.get<{ Params: { ref: string; name: string } }>("/v1/projects/:ref/functions/:name", async (req) => control.getFunction(await principal(req), refParam(req), req.params.name));
  app.put<{ Params: { ref: string; name: string } }>("/v1/projects/:ref/functions/:name", async (req) => {
    const b = body(req);
    return control.deployFunction(await principal(req), refParam(req), req.params.name, b.source as string, b.verify_jwt !== false);
  });
  app.delete<{ Params: { ref: string; name: string } }>("/v1/projects/:ref/functions/:name", async (req, reply) => {
    await control.deleteFunction(await principal(req), refParam(req), req.params.name);
    return reply.code(204).send();
  });
  if (ops.functions) {
    app.get<{ Params: { ref: string; name: string } }>("/v1/projects/:ref/functions/:name/logs", async (req) => {
      const { ref } = await owned(req, "admin");
      return ops.functions!.logsFor(ref, req.params.name).reverse();
    });
  }

  // ---- database access for admins ----
  if (ops.admin) {
    app.post<{ Params: { ref: string } }>("/v1/projects/:ref/sql", async (req) => {
      const { p, ref } = await owned(req, "admin");
      const q = body(req).query;
      const results = await ops.admin!.run(ref, q as string);
      await control.audit(p.tokenId, p.orgId, "project.sql", ref, { statement: String(q).slice(0, 200) });
      return { results };
    });
    app.post<{ Params: { ref: string } }>("/v1/projects/:ref/policy-test", async (req) => {
      const { ref } = await owned(req, "admin");
      const b = body(req);
      return ops.admin!.testAccess(ref, b.table, b.as);
    });
    app.get<{ Params: { ref: string } }>("/v1/projects/:ref/tables", async (req) => ops.admin!.tables((await owned(req)).ref));
  }

  // ---- AI assistant ----
  if (ops.ai) {
    const ai = ops.ai;
    app.get<{ Params: { ref: string } }>("/v1/projects/:ref/ai", async (req) => ai.status(await principal(req), refParam(req)));
    app.post<{ Params: { ref: string } }>("/v1/projects/:ref/ai/enable", async (req) => ai.setEnabled(await principal(req), refParam(req), true));
    app.post<{ Params: { ref: string } }>("/v1/projects/:ref/ai/disable", async (req) => ai.setEnabled(await principal(req), refParam(req), false));
    app.post<{ Params: { ref: string } }>("/v1/projects/:ref/ai/ask", async (req) => {
      const b = body(req);
      return ai.ask(await principal(req), refParam(req), b.question, b.history, b.as);
    });
    app.put<{ Params: { ref: string } }>("/v1/projects/:ref/ai/config", async (req) => {
      const b = body(req);
      if (typeof b.allowBypassRls !== "boolean") throw new HttpError(400, "allowBypassRls must be true or false");
      return ai.setAllowBypass(await principal(req), refParam(req), b.allowBypassRls);
    });
    app.get<{ Params: { ref: string } }>("/v1/projects/:ref/ai/users", async (req) => ai.listUsers(await principal(req), refParam(req), String((req.query as Record<string, string>).q ?? "")));
  }

  // ---- pipelines (row changes to a webhook) ----
  if (ops.pipelines) {
    const pl = ops.pipelines;
    const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
    app.get("/v1/projects/:ref/pipelines", async (req) => pl.list(await principal(req), refParam(req)));
    app.post("/v1/projects/:ref/pipelines", async (req, reply) => reply.code(201).send(await pl.create(await principal(req), refParam(req), body(req))));
    app.patch("/v1/projects/:ref/pipelines/:id", async (req) => pl.update(await principal(req), refParam(req), idOf(req), body(req)));
    app.delete("/v1/projects/:ref/pipelines/:id", async (req, reply) => {
      await pl.remove(await principal(req), refParam(req), idOf(req));
      return reply.code(204).send();
    });
    app.post("/v1/projects/:ref/pipelines/:id/rotate-secret", async (req) => pl.rotateSecret(await principal(req), refParam(req), idOf(req)));
    app.post("/v1/projects/:ref/pipelines/:id/test", async (req) => pl.test(await principal(req), refParam(req), idOf(req)));
    app.post("/v1/projects/:ref/pipelines/:id/run", async (req) => pl.run(await principal(req), refParam(req), idOf(req)));
    app.get("/v1/projects/:ref/pipelines/:id/deliveries", async (req) => pl.deliveries(await principal(req), refParam(req), idOf(req)));
  }

  // ---- postgres extensions ----
  if (ops.extensions) {
    const ex = ops.extensions;
    app.get("/v1/projects/:ref/extensions", async (req) => ex.list(await principal(req), refParam(req)));
    app.post("/v1/projects/:ref/extensions", async (req) => {
      const b = body(req);
      return ex.set(await principal(req), refParam(req), b.name, b.install);
    });
  }

  // ---- usage and logs ----
  if (ops.usage) {
    app.get<{ Params: { ref: string } }>("/v1/projects/:ref/usage", async (req) => {
      const { ref, project } = await owned(req);
      const plan = planOf(project.plan);
      return { plan: project.plan, limits: plan, ...(await ops.usage!.report(ref, Number((req.query as Record<string, string>).days) || 30)) };
    });
    app.get<{ Params: { ref: string } }>("/v1/projects/:ref/metrics", async (req) => ops.usage!.metrics((await owned(req)).ref, Number((req.query as Record<string, string>).hours) || 24));
    app.get<{ Params: { ref: string } }>("/v1/projects/:ref/logs", async (req) => ops.usage!.logsFor((await owned(req, "admin")).ref));
  }

  // ---- backups ----
  if (ops.backups) {
    app.get<{ Params: { ref: string } }>("/v1/projects/:ref/backups", async (req) => ops.backups!.list(await principal(req), refParam(req)));
    app.post<{ Params: { ref: string } }>("/v1/projects/:ref/backups", async (req, reply) => {
      const b = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const row = await ops.backups!.create(await principal(req), refParam(req), "manual", typeof b.note === "string" ? b.note.slice(0, 200) : undefined);
      return reply.code(201).send(row);
    });
    app.post<{ Params: { ref: string; id: string } }>("/v1/projects/:ref/backups/:id/restore", async (req) => {
      await ops.backups!.restore(await principal(req), refParam(req), req.params.id);
      return { restored: true };
    });
    app.delete<{ Params: { ref: string; id: string } }>("/v1/projects/:ref/backups/:id", async (req, reply) => {
      await ops.backups!.delete(await principal(req), refParam(req), req.params.id);
      return reply.code(204).send();
    });
  }

  // ---- dashboard ----
  app.get("/v1/config", async () => ({ gateway: ops.gateway ?? null, member_email_reset: members.emailResetAvailable }));
  if (ops.dashboardDir) {
    const dir = ops.dashboardDir;
    const types: Record<string, string> = { "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "style.css": "text/css; charset=utf-8" };
    const serve = async (file: string, reply: import("fastify").FastifyReply) => {
      if (!Object.hasOwn(types, file)) throw new HttpError(404, "not found");
      return reply
        .header("content-type", types[file]!)
        .header("cache-control", "no-cache")
        .header("x-content-type-options", "nosniff")
        .header("x-frame-options", "DENY")
        .header("content-security-policy", "default-src 'self'; connect-src *; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'")
        .send(await readFile(`${dir}/${file}`));
    };
    app.get("/", (_req, reply) => serve("index.html", reply));
    app.get<{ Params: { file: string } }>("/dashboard/:file", (req, reply) => serve(req.params.file, reply));
  }
  return app;
}
