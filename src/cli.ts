import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type CliIO = {
  out: (s: string) => void; err: (s: string) => void; cwd: string; env: Record<string, string | undefined>; fetch?: typeof fetch;
  /** For commands that wait (--follow). Tests replace both; the real CLI wires `signal` to Ctrl-C. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

type Config = { url: string; token: string };

class CliError extends Error {}

const USAGE = `baas <command>

  login --url <api-url> --token <token>   save credentials
  login --url <api-url> --email <e> [--password <p>] [--code <6 digits>]   sign in as a member (password may come from BAAS_PASSWORD; code if you use an authenticator)
  logout | whoami
  projects list | create <name> | pause|resume|delete <ref>
  link <ref>                              remember a project for this directory
  keys                                    show the project's API keys
  sql "<query>" | sql --file <file>       run SQL as service_role
  db push [--dir baas/migrations]         apply pending .sql migrations in order
  db status [--dir baas/migrations]
  functions list | deploy <name> <file> [--no-verify-jwt] | delete <name> | logs <name>
  backups list | create [--note <text>] | restore <id>
  pipelines list | show <pipeline>        send row changes to a webhook (admin role); <pipeline> is a name or id
  pipelines create <name> --tables <a,b> --url <url> [--events insert,update,delete] [--no-rows] [--where <table.column:op:value>]...
  pipelines edit <pipeline> [--name <n>] [--tables <a,b>] [--url <url>] [--events <list>] [--rows|--no-rows] [--where …]... | [--no-where]
  pipelines deliveries <pipeline> [--follow [--interval <seconds>]]   --follow keeps printing new deliveries until Ctrl-C
  pipelines pause|resume|run|test|rotate-secret|delete <pipeline>
                                          --where sends only rows that match, e.g. orders.status:eq:paid, orders.total:gte:100,
                                          orders.region:in:eu|us, orders.note:null (ops: eq neq gt gte lt lte in null notnull)
  extensions list [--installed|--available] [--search <text>]   Postgres extensions (admin role)
  extensions install|remove <name...>     only extensions Postgres marks as safe for database owners can be installed
  ai status | enable | disable             the plain-language SQL assistant (needs a server-side Anthropic key)
  ai config --allow-bypass-rls true|false   let it ignore row-level security ("everyone" mode; owner only to allow)
  ask "<question>" [--as anon|all] [--as-user <email>]
                                          ask about your data; by default as an anonymous visitor with row-level security
                                          applied. Changes are only ever proposed, never run
  usage

Project: --ref <ref>, or BAAS_PROJECT, or the link made by "baas link".`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["no-verify-jwt", "no-rows", "rows", "installed", "available", "no-where", "follow"].includes(key)) {
        if (key === "where") (multi.where ??= []).push(next);
        else flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags, multi };
}

const table = (rows: string[][]) => {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
};

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const f = io.fetch ?? fetch;
  const configDir = io.env.BAAS_CONFIG_DIR ?? join(io.env.HOME ?? homedir(), ".config", "baas");
  const configFile = join(configDir, "config.json");
  const { pos, flags, multi } = parseArgs(argv);
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
        let token = String(flags.token ?? "");
        if (!/^https?:\/\//.test(url)) throw new CliError("usage: baas login --url <api-url> (--token <token> | --email <email> [--password <password>])");
        if (!token && flags.email) {
          const password = String(flags.password ?? io.env.BAAS_PASSWORD ?? "");
          if (!password) throw new CliError("a password is needed: pass --password or set BAAS_PASSWORD");
          const res = await f(`${url}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: String(flags.email), password }) });
          let data = (await res.json().catch(() => ({}))) as { token?: string; error?: string; mfa_required?: boolean; mfa_token?: string };
          if (res.ok && data.mfa_required) {
            const code = String(flags.code ?? io.env.BAAS_MFA_CODE ?? "");
            if (!code) throw new CliError("this account uses an authenticator: add --code <6 digits> (or a recovery code), or set BAAS_MFA_CODE");
            const second = await f(`${url}/v1/auth/mfa`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mfa_token: data.mfa_token, code }) });
            data = (await second.json().catch(() => ({}))) as typeof data;
            if (!second.ok) throw new CliError(data.error ?? `sign-in failed (${second.status})`);
          } else if (!res.ok) throw new CliError(data.error ?? `sign-in failed (${res.status})`);
          if (!data.token) throw new CliError("sign-in failed");
          token = data.token;
        }
        if (!token) throw new CliError("usage: baas login --url <api-url> (--token <token> | --email <email> [--password <password>])");
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
      case "pipelines": {
        const ref = await projectRef();
        const base = `/v1/projects/${ref}/pipelines`;
        const one = async (which: string | undefined) => {
          if (!which) throw new CliError("name the pipeline: baas pipelines list shows names and ids");
          const all = (await api("GET", base)) as any[];
          const hit = all.filter((x) => x.id === which || x.name.toLowerCase() === which.toLowerCase());
          const found = hit.length ? hit : which.length >= 8 ? all.filter((x) => x.id.startsWith(which)) : [];
          if (found.length > 1) throw new CliError(`"${which}" matches more than one pipeline; use its id`);
          if (!found[0]) throw new CliError(`no pipeline named "${which}"`);
          return found[0];
        };
        const list = (v: unknown, what: string, upper = false) => {
          const items = String(v).split(",").map((x) => x.trim()).filter(Boolean).map((x) => (upper ? x.toUpperCase() : x));
          if (!items.length) throw new CliError(`${what} must be a comma-separated list`);
          return items;
        };
        const when = (d: unknown) => (d ? new Date(String(d)).toISOString().replace("T", " ").slice(0, 19) : "never");
        const secretNote = (secret: string) => `Signing secret (shown once, keep it safe):\n  ${secret}\nDeliveries carry X-Baas-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>">.`;
        const whereFilters = () => {
          const out: Record<string, Array<Record<string, unknown>>> = {};
          for (const w of multi.where ?? []) {
            const m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*):(eq|neq|gt|gte|lt|lte|in|null|notnull)(?::(.*))?$/s.exec(w);
            if (!m) throw new CliError(`cannot read --where "${w}": use table.column:op:value, for example orders.status:eq:paid`);
            const [, table, column, op, value] = m as unknown as [string, string, string, string, string | undefined];
            if (op === "null" || op === "notnull") {
              if (value !== undefined) throw new CliError(`--where "${w}": ${op} takes no value`);
              (out[table] ??= []).push({ column, op });
            } else {
              if (value === undefined || value === "") throw new CliError(`--where "${w}": ${op} needs a value`);
              (out[table] ??= []).push({ column, op, value: op === "in" ? value.split("|") : value });
            }
          }
          return out;
        };
        const fields = () => {
          const body: Record<string, unknown> = {};
          if (multi.where?.length) body.filters = whereFilters();
          else if (flags["no-where"] === true) body.filters = {};
          if (typeof flags.name === "string") body.name = flags.name;
          if (flags.tables !== undefined) body.tables = list(flags.tables, "--tables");
          if (flags.events !== undefined) body.events = list(flags.events, "--events", true);
          if (typeof flags.url === "string") body.url = flags.url;
          if (flags["no-rows"] === true) body.include_rows = false;
          else if (flags.rows === true) body.include_rows = true;
          return body;
        };
        if (sub === "list" || sub === undefined) {
          const rows = (await api("GET", base)) as any[];
          io.out(rows.length
            ? table([["NAME", "STATUS", "TABLES", "EVENTS", "DELIVERED", "LAST DELIVERY", "DESTINATION"], ...rows.map((x) => [x.name, x.status, x.tables.join(","), x.events.map((e: string) => e[0]).join(""), String(x.delivered), when(x.last_success_at), (() => { try { return new URL(x.url).host; } catch { return x.url; } })()])])
            : "No pipelines.");
        } else if (sub === "show") {
          const x = await one(rest[0]);
          io.out([`name:        ${x.name}`, `id:          ${x.id}`, `status:      ${x.status}${x.disabled_reason ? ` (${x.disabled_reason})` : ""}`, `tables:      ${x.tables.join(", ")}`, `events:      ${x.events.join(", ")}`,
            `rows:        ${x.include_rows ? "included" : "primary key only"}`,
            ...Object.entries(x.filters ?? {}).map(([t, cs]) => `only rows:   ${t}: ${(cs as any[]).map((c) => `${c.column} ${{ eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", in: "in", null: "is null", notnull: "is not null" }[c.op as string]}${c.op === "null" || c.op === "notnull" ? "" : ` ${Array.isArray(c.value) ? `(${c.value.join(", ")})` : c.value}`}`).join(" and ")}`), `destination: ${x.url}`, `delivered:   ${x.delivered}, failed ${x.failed}`, `last ok:     ${when(x.last_success_at)}`,
            ...(x.last_error ? [`last error:  ${x.last_error}`] : [])].join("\n"));
        } else if (sub === "create") {
          if (!rest[0] || flags.tables === undefined || typeof flags.url !== "string") throw new CliError("usage: baas pipelines create <name> --tables <a,b> --url <url> [--events insert,update,delete] [--no-rows]");
          const x = await api("POST", base, { ...fields(), name: rest[0] });
          io.out(`Created pipeline ${x.name} (${x.id}). It sends changes made from now on.\n${secretNote(x.secret)}`);
        } else if (sub === "edit") {
          const x = await one(rest[0]);
          const body = fields();
          if (!Object.keys(body).length) throw new CliError("nothing to change: pass --name, --tables, --url, --events, --rows, --no-rows, --where or --no-where");
          const r = await api("PATCH", `${base}/${x.id}`, body);
          io.out(`Updated ${r.name}.`);
        } else if (sub === "pause" || sub === "resume") {
          const x = await one(rest[0]);
          const r = await api("PATCH", `${base}/${x.id}`, { enabled: sub === "resume" });
          io.out(`${r.name}: ${r.status}`);
        } else if (sub === "run") {
          const x = await one(rest[0]);
          const r = await api("POST", `${base}/${x.id}/run`);
          io.out(`${r.name}: ${r.status}, ${r.delivered} delivered${r.last_error ? `\nlast error: ${r.last_error}` : ""}`);
        } else if (sub === "test") {
          const x = await one(rest[0]);
          const r = await api("POST", `${base}/${x.id}/test`);
          if (!r.ok) throw new CliError(`test event failed${r.status ? ` (${r.status})` : ""}: ${r.error}`);
          io.out(`Test event delivered: ${r.status} in ${r.ms} ms.`);
        } else if (sub === "deliveries") {
          const x = await one(rest[0]);
          const line = (d: any) => `${when(d.at)}  ${d.kind.padEnd(8)}  ${(d.ok ? `ok ${d.status}` : (d.error ?? "failed").slice(0, 80)).padEnd(14)}  ${String(d.events).padStart(3)} event${d.events === 1 ? " " : "s"}  ${d.ms ?? ""} ms`;
          const fetchRows = async () => (await api("GET", `${base}/${x.id}/deliveries`)) as any[];
          if (flags.follow === true) {
            const secs = flags.interval === undefined ? 2 : Number(flags.interval);
            if (!Number.isFinite(secs) || secs < 1 || secs > 3600) throw new CliError("--interval must be between 1 and 3600 seconds");
            const wait = io.sleep ?? ((ms, sig) => new Promise<void>((done) => { const t = setTimeout(done, ms); sig?.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true }); }));
            io.out(`Following deliveries for ${x.name} (Ctrl-C to stop)…`);
            const first = (await fetchRows()).slice(0, 10).reverse();
            let seen = first.length ? BigInt(first[first.length - 1].id) : -1n;
            for (const d of first) io.out(line(d));
            while (!io.signal?.aborted) {
              await wait(secs * 1000, io.signal);
              if (io.signal?.aborted) break;
              const fresh = (await fetchRows()).filter((d) => BigInt(d.id) > seen).reverse();
              for (const d of fresh) { io.out(line(d)); seen = BigInt(d.id); }
            }
            return 0;
          }
          const rows = await fetchRows();
          io.out(rows.length ? table([["WHEN", "KIND", "RESULT", "EVENTS", "MS"], ...rows.map((d) => [when(d.at), d.kind, d.ok ? `ok ${d.status}` : (d.error ?? "failed").slice(0, 80), String(d.events), String(d.ms ?? "")])]) : "No deliveries yet.");
        } else if (sub === "rotate-secret") {
          const x = await one(rest[0]);
          const r = await api("POST", `${base}/${x.id}/rotate-secret`);
          io.out(`New signing secret for ${x.name}; the old one no longer signs.\n${secretNote(r.secret)}`);
        } else if (sub === "delete") {
          const x = await one(rest[0]);
          await api("DELETE", `${base}/${x.id}`);
          io.out(`Deleted ${x.name}.`);
        } else throw new CliError("usage: baas pipelines list | show | create | edit | pause | resume | run | test | deliveries | rotate-secret | delete (see baas help)");
        return 0;
      }
      case "extensions": {
        const ref = await projectRef();
        const base = `/v1/projects/${ref}/extensions`;
        if (sub === "list" || sub === undefined) {
          if (flags.installed === true && flags.available === true) throw new CliError("use --installed or --available, not both");
          const q = typeof flags.search === "string" ? flags.search.toLowerCase() : "";
          const rows = ((await api("GET", base)) as any[])
            .filter((e) => (flags.installed === true ? e.installed : flags.available === true ? !e.installed : true) && (!q || `${e.name} ${e.comment ?? ""}`.toLowerCase().includes(q)))
            .sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.installable) - Number(a.installable) || a.name.localeCompare(b.name));
          const state = (e: any) => (e.installed ? (e.protected ? "installed (required)" : "installed") : e.installable ? "available" : "needs operator");
          io.out(rows.length ? table([["NAME", "VERSION", "STATE", "SCHEMA", "DESCRIPTION"], ...rows.map((e) => [e.name, e.installed_version ?? e.version, state(e), e.schema ?? "", (e.comment ?? "").slice(0, 60)])]) : "No matching extensions.");
        } else if ((sub === "install" || sub === "remove") && rest.length) {
          for (const name of rest) {
            const r = await api("POST", base, { name, install: sub === "install" });
            io.out(sub === "install" ? `Installed ${r.name} ${r.installed_version} in schema ${r.schema}; call its functions as ${r.schema}.<name>().` : `Removed ${r.name}.`);
          }
        } else throw new CliError("usage: baas extensions list [--installed|--available] [--search <text>] | install|remove <name...>");
        return 0;
      }
      case "ai": {
        const ref = await projectRef();
        if (sub === "enable" || sub === "disable") {
          const st = await api("POST", `/v1/projects/${ref}/ai/${sub}`);
          io.out(`AI assistant ${st.enabled ? "enabled" : "disabled"}.${st.enabled ? `\n${st.notice}` : ""}`);
        } else if (sub === "config") {
          const v = String(flags["allow-bypass-rls"] ?? "");
          if (v !== "true" && v !== "false") throw new CliError("usage: baas ai config --allow-bypass-rls true|false");
          const st = await api("PUT", `/v1/projects/${ref}/ai/config`, { allowBypassRls: v === "true" });
          io.out(`"Everyone" mode is ${st.allowBypassRls ? "allowed" : "not allowed"}; the assistant asks as ${st.defaultIdentity === "service" ? "everyone" : "an anonymous visitor"} by default.`);
        } else if (sub === "status" || sub === undefined) {
          const st = await api("GET", `/v1/projects/${ref}/ai`);
          io.out(st.available ? `AI assistant: ${st.enabled ? "on" : "off"} (${st.model}), ${st.questionsToday}/${st.questionsPerDay} questions today; row-level security ${st.allowBypassRls ? "can be ignored (everyone mode allowed)" : "always applies"}` : "AI assistant: not configured on this server");
        } else throw new CliError("usage: baas ai status | enable | disable | config --allow-bypass-rls true|false");
        return 0;
      }
      case "ask": {
        const ref = await projectRef();
        const question = [sub, ...rest].filter(Boolean).join(" ");
        if (!question.trim()) throw new CliError('usage: baas ask "<question>"');
        let as: unknown;
        if (typeof flags["as-user"] === "string") {
          const who = flags["as-user"];
          const users = (await api("GET", `/v1/projects/${ref}/ai/users?q=${encodeURIComponent(who)}`)) as Array<{ id: string; email: string }>;
          const hit = users.find((u) => u.email.toLowerCase() === who.toLowerCase() || u.id === who);
          if (!hit) throw new CliError(`no user matches "${who}"`);
          as = { type: "user", userId: hit.id };
        } else if (flags.as === "anon") as = { type: "anon" };
        else if (flags.as === "all") as = { type: "service" };
        else if (flags.as !== undefined) throw new CliError('--as must be "anon" or "all" (or use --as-user <email>)');
        const r = await api("POST", `/v1/projects/${ref}/ai/ask`, { question, ...(as ? { as } : {}) });
        io.out(`(answering as ${r.answeredAs.label})\n${r.answer}`);
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
