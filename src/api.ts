import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ControlPlane, HttpError, type Principal, type ProjectRow, type Role } from "./control.js";

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
export function buildApi(control: ControlPlane, bootstrapToken: string): FastifyInstance {
  if (bootstrapToken.length < 24) throw new Error("bootstrap token must be at least 24 characters");
  const app = Fastify({ logger: false });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

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
    return reply.code(201).send({ organization: org, owner_token: ownerToken });
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
  app.patch<{ Params: { ref: string } }>("/v1/projects/:ref/settings", async (req) => control.updateSettings(await principal(req), req.params.ref, body(req)));

  app.get("/v1/audit-log", async (req) => control.auditLog(await principal(req)));

  app.get("/healthz", async () => ({ ok: true }));
  return app;
}
