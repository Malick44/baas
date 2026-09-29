import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type CliIO = { out: (s: string) => void; err: (s: string) => void; cwd: string; env: Record<string, string | undefined>; fetch?: typeof fetch };

type Config = { url: string; token: string };

class CliError extends Error {}

const USAGE = `baas <command>

  login --url <api-url> --token <token>   save credentials
  logout | whoami
  projects list | create <name> | pause|resume|delete <ref>
  link <ref>                              remember a project for this directory
  keys                                    show the project's API keys
  sql "<query>" | sql --file <file>       run SQL as service_role
  db push [--dir baas/migrations]         apply pending .sql migrations in order
  db status [--dir baas/migrations]
  functions list | deploy <name> <file> [--no-verify-jwt] | delete <name> | logs <name>
  backups list | create [--note <text>] | restore <id>
  ai status | enable | disable             the plain-language SQL assistant (needs a server-side Anthropic key)
  ask "<question>"                        ask about your data; changes are only ever proposed, never run
  usage

Project: --ref <ref>, or BAAS_PROJECT, or the link made by "baas link".`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["no-verify-jwt"].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const table = (rows: string[][]) => {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
};

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const f = io.fetch ?? fetch;
  const configDir = io.env.BAAS_CONFIG_DIR ?? join(io.env.HOME ?? homedir(), ".config", "baas");
  const configFile = join(configDir, "config.json");
  const { pos, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;

  async function config(): Promise<Config> {
    try {
      return JSON.parse(await readFile(configFile, "utf8")) as Config;
    } catch {
      throw new CliError('not logged in: run "baas login --url <api-url> --token <token>"');
    }
  }

  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const c = await config();
    let res: Response;
    try {
      res = await f(`${c.url}${path}`, { method, headers: { authorization: `Bearer ${c.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new CliError(`cannot reach ${c.url}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new CliError(`${res.status}: ${data?.error ?? data?.message ?? res.statusText}`);
    return data;
  }

  async function projectRef(): Promise<string> {
    const ref = (typeof flags.ref === "string" && flags.ref) || io.env.BAAS_PROJECT || (await readFile(join(io.cwd, ".baas", "project"), "utf8").then((s) => s.trim(), () => ""));
    if (!/^[a-z0-9]{20}$/.test(ref)) throw new CliError('no project selected: pass --ref, set BAAS_PROJECT, or run "baas link <ref>"');
    return ref;
  }

  const sql = async (ref: string, query: string) => (await api("POST", `/v1/projects/${ref}/sql`, { query })).results as Array<{ command: string; rowCount: number | null; fields: string[]; rows: unknown[][]; truncated: boolean }>;
  const cell = (v: unknown) => (v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v));

  async function migrations(dir: string) {
    const files = (await readdir(dir).catch(() => { throw new CliError(`migrations directory not found: ${dir}`); })).filter((n) => n.endsWith(".sql")).sort();
    return Promise.all(files.map(async (name) => {
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(name)) throw new CliError(`unsupported migration file name: ${name}`);
      const sqlText = await readFile(join(dir, name), "utf8");
      return { name, sql: sqlText, sha: createHash("sha256").update(sqlText).digest("hex") };
    }));
  }
  const ensureLedger = (ref: string) =>
    sql(ref, "CREATE SCHEMA IF NOT EXISTS baas_internal; CREATE TABLE IF NOT EXISTS baas_internal.migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = async (ref: string) => new Map((await sql(ref, "SELECT name, sha256 FROM baas_internal.migrations")).at(0)!.rows.map((r) => [r[0] as string, r[1] as string]));

  try {
    switch (cmd) {
      case "login": {
        const url = String(flags.url ?? "").replace(/\/+$/, "");
        const token = String(flags.token ?? "");
        if (!/^https?:\/\//.test(url) || !token) throw new CliError("usage: baas login --url <api-url> --token <token>");
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        await writeFile(configFile, JSON.stringify({ url, token }), { mode: 0o600 });
        await chmod(configFile, 0o600);
        const n = (await api("GET", "/v1/projects")).length;
        io.out(`Logged in to ${url} (${n} project${n === 1 ? "" : "s"}).`);
        return 0;
      }
      case "logout":
        await writeFile(configFile, "{}", { mode: 0o600 }).catch(() => {});
        io.out("Logged out.");
        return 0;
      case "whoami": {
        const c = await config();
        const projects = await api("GET", "/v1/projects");
        io.out(`${c.url}\n${projects.length} project${projects.length === 1 ? "" : "s"}`);
        return 0;
      }
      case "projects": {
        if (sub === "list") {
          const rows = await api("GET", "/v1/projects");
          io.out(rows.length ? table([["REF", "NAME", "STATUS", "PLAN"], ...rows.map((p: any) => [p.ref, p.name, p.status, p.plan])]) : "No projects.");
        } else if (sub === "create" && rest[0]) {
          const p = await api("POST", "/v1/projects", { name: rest[0] });
          io.out(`Created ${p.name} (${p.ref}), status ${p.status}.`);
        } else if ((sub === "pause" || sub === "resume" || sub === "delete") && rest[0]) {
          const p = await api(sub === "delete" ? "DELETE" : "POST", `/v1/projects/${rest[0]}${sub === "delete" ? "" : `/${sub}`}`);
          io.out(`${rest[0]}: ${p.status}`);
        } else throw new CliError("usage: baas projects list | create <name> | pause|resume|delete <ref>");
        return 0;
      }
      case "link": {
        if (!/^[a-z0-9]{20}$/.test(sub ?? "")) throw new CliError("usage: baas link <ref>");
        await api("GET", `/v1/projects/${sub}`); // confirm it exists and is ours
        await mkdir(join(io.cwd, ".baas"), { recursive: true });
        await writeFile(join(io.cwd, ".baas", "project"), `${sub}\n`);
        io.out(`Linked ${sub}.`);
        return 0;
      }
      case "keys": {
        const k = await api("GET", `/v1/projects/${await projectRef()}/api-keys`);
        io.out(`anon:         ${k.anon}\nservice_role: ${k.service_role ?? "(requires admin role)"}`);
        return 0;
      }
      case "sql": {
        const ref = await projectRef();
        const query = typeof flags.file === "string" ? await readFile(join(io.cwd, flags.file), "utf8") : [sub, ...rest].filter(Boolean).join(" ");
        if (!query.trim()) throw new CliError('usage: baas sql "<query>" | baas sql --file <file>');
        for (const r of await sql(ref, query)) {
          if (r.fields.length) {
            io.out(table([r.fields, ...r.rows.map((row) => row.map(cell))]));
            io.out(`(${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${r.truncated ? ", output truncated" : ""})`);
          } else io.out(`${r.command}${r.rowCount ? ` ${r.rowCount}` : ""}`);
        }
        return 0;
      }
      case "db": {
        const ref = await projectRef();
        const dir = join(io.cwd, typeof flags.dir === "string" ? flags.dir : join("baas", "migrations"));
        const local = await migrations(dir);
        await ensureLedger(ref);
        const done = await applied(ref);
        for (const m of local) {
          const prev = done.get(m.name);
          if (prev && prev !== m.sha) throw new CliError(`migration ${m.name} was changed after it was applied; add a new migration instead`);
        }
        const localNames = new Set(local.map((m) => m.name));
        const missing = [...done.keys()].filter((n) => !localNames.has(n));
        const pending = local.filter((m) => !done.has(m.name));
        if (sub === "status") {
          io.out(table([["MIGRATION", "STATE"], ...local.map((m) => [m.name, done.has(m.name) ? "applied" : "pending"]), ...missing.map((n) => [n, "applied (file missing locally)"])]));
          return 0;
        }
        if (sub !== "push") throw new CliError("usage: baas db push | status");
        if (!pending.length) {
          io.out("Database is up to date.");
          return 0;
        }
        for (const m of pending) {
          if (/^\s*(begin|commit|rollback)\b/im.test(m.sql)) io.err(`warning: ${m.name} manages its own transaction; it will not be atomic`);
          try {
            // One request is one transaction: the migration and its ledger row commit together or not at all.
            await sql(ref, `${m.sql}\n;INSERT INTO baas_internal.migrations (name, sha256) VALUES ('${m.name}', '${m.sha}')`);
          } catch (e) {
            throw new CliError(`migration ${m.name} failed and was rolled back: ${(e as Error).message}`);
          }
          io.out(`applied ${m.name}`);
        }
        return 0;
      }
      case "functions": {
        const ref = await projectRef();
        if (sub === "list") {
          const rows = await api("GET", `/v1/projects/${ref}/functions`);
          io.out(rows.length ? table([["NAME", "VERSION", "VERIFY_JWT", "SIZE"], ...rows.map((r: any) => [r.name, String(r.version), String(r.verify_jwt), String(r.size)])]) : "No functions.");
        } else if (sub === "deploy" && rest[0] && rest[1]) {
          const source = await readFile(join(io.cwd, rest[1]), "utf8");
          const r = await api("PUT", `/v1/projects/${ref}/functions/${rest[0]}`, { source, verify_jwt: flags["no-verify-jwt"] !== true });
          io.out(`Deployed ${r.name} v${r.version}.`);
        } else if (sub === "delete" && rest[0]) {
          await api("DELETE", `/v1/projects/${ref}/functions/${rest[0]}`);
          io.out(`Deleted ${rest[0]}.`);
        } else if (sub === "logs" && rest[0]) {
          const rows = await api("GET", `/v1/projects/${ref}/functions/${rest[0]}/logs`);
          io.out(rows.length ? rows.map((l: any) => `${l.at} ${l.status} ${l.ms}ms${l.note ? ` ${l.note}` : ""}`).join("\n") : "No invocations yet.");
        } else throw new CliError("usage: baas functions list | deploy <name> <file> [--no-verify-jwt] | delete <name> | logs <name>");
        return 0;
      }
      case "backups": {
        const ref = await projectRef();
        if (sub === "list") {
          const rows = await api("GET", `/v1/projects/${ref}/backups`);
          io.out(rows.length ? table([["ID", "STATUS", "SIZE", "CREATED", "NOTE"], ...rows.map((b: any) => [b.id, b.status, b.size_bytes ?? "-", String(b.created_at), b.note ?? ""])]) : "No backups.");
        } else if (sub === "create") {
          const b = await api("POST", `/v1/projects/${ref}/backups`, { note: typeof flags.note === "string" ? flags.note : undefined });
          io.out(`Backup ${b.id} ${b.status} (${b.size_bytes} bytes).`);
        } else if (sub === "restore" && rest[0]) {
          await api("POST", `/v1/projects/${ref}/backups/${rest[0]}/restore`);
          io.out(`Restored ${ref} from ${rest[0]}.`);
        } else throw new CliError("usage: baas backups list | create [--note <text>] | restore <id>");
        return 0;
      }
      case "ai": {
        const ref = await projectRef();
        if (sub === "enable" || sub === "disable") {
          const st = await api("POST", `/v1/projects/${ref}/ai/${sub}`);
          io.out(`AI assistant ${st.enabled ? "enabled" : "disabled"}.${st.enabled ? `\n${st.notice}` : ""}`);
        } else if (sub === "status" || sub === undefined) {
          const st = await api("GET", `/v1/projects/${ref}/ai`);
          io.out(st.available ? `AI assistant: ${st.enabled ? "on" : "off"} (${st.model}), ${st.questionsToday}/${st.questionsPerDay} questions today` : "AI assistant: not configured on this server");
        } else throw new CliError("usage: baas ai status | enable | disable");
        return 0;
      }
      case "ask": {
        const ref = await projectRef();
        const question = [sub, ...rest].filter(Boolean).join(" ");
        if (!question.trim()) throw new CliError('usage: baas ask "<question>"');
        const r = await api("POST", `/v1/projects/${ref}/ai/ask`, { question });
        io.out(r.answer);
        for (const st of r.steps.filter((x: any) => x.tool === "run_query")) io.out(`\n  ${st.ok ? "ran" : "failed"} (read-only): ${st.sql.replace(/\s+/g, " ")}${st.error ? `\n    ${st.error}` : ""}`);
        for (const pr of r.proposals) {
          io.out(`\nProposed change — NOT run.${pr.risk.destructive ? " DESTRUCTIVE:" : " It would:"} ${pr.risk.flags.join("; ")}`);
          if (pr.explanation) io.out(`The assistant says: ${pr.explanation}`);
          io.out(`${pr.sql}\nReview it, then apply it yourself: save it to a file and run "baas sql --file <file>".`);
        }
        return 0;
      }
      case "usage": {
        const u = await api("GET", `/v1/projects/${await projectRef()}/usage`);
        const today = u.daily[0];
        io.out([`plan: ${u.plan}`, `requests today: ${today?.requests ?? 0} / ${u.limits.requestsPerDay}`, `database: ${u.current?.db_bytes ?? 0} / ${u.limits.dbBytes} bytes`, `storage: ${u.current?.storage_bytes ?? 0} / ${u.limits.storageBytes} bytes`].join("\n"));
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        io.out(USAGE);
        return 0;
      default:
        io.err(`unknown command: ${cmd}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

export const cliName = basename(process.argv[1] ?? "baas");
