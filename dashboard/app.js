// baas dashboard: a dependency-free single-page app.
// All DOM is built with h() and textContent; nothing is ever assigned via innerHTML.

// ---------- helpers ----------
const $app = document.getElementById("app");

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}
const clear = (el) => el.replaceChildren();
const fmtBytes = (n) => {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : "—");
const ident = (s) => /^[a-z_][a-z0-9_]{0,62}$/.test(s);
const qi = (s) => `"${s}"`;
const truncate = (s, n = 200) => (s.length > n ? s.slice(0, n) + "…" : s);

function toast(msg, kind = "") {
  const t = h("div", { class: `toast ${kind}`, role: "status" }, msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 7000 : 3500);
}

function dialog(title, build, { confirmLabel = "OK", danger = false, onSubmit } = {}) {
  return new Promise((resolve) => {
    const err = h("div", { class: "notice bad", hidden: true });
    const form = h("form", { method: "dialog" }, h("h2", null, title), build(), err);
    const ok = h("button", { class: danger ? "danger" : "primary", type: "submit" }, confirmLabel);
    const cancel = h("button", { type: "button", onclick: () => dlg.close() }, "Cancel");
    form.append(h("div", { class: "actions" }, cancel, ok));
    const dlg = h("dialog", null, form);
    let result = null;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      ok.disabled = true;
      try {
        result = onSubmit ? await onSubmit(new FormData(form), form) : true;
        dlg.close();
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.message || String(ex);
        ok.disabled = false;
      }
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector("input, textarea, select")?.focus();
  });
}

const confirmBox = (title, text, { confirmLabel = "Confirm", danger = true, typed } = {}) =>
  dialog(title, () => h("div", { class: "stack" }, h("p", null, text), typed && h("label", { class: "field" }, `Type "${typed}" to confirm`, h("input", { name: "typed", autocomplete: "off" }))), {
    confirmLabel, danger,
    onSubmit: (fd) => { if (typed && fd.get("typed") !== typed) throw new Error("The name does not match."); return true; },
  });

// ---------- state and API ----------
const S = { token: null, me: null, config: null, project: null, keys: null, tables: null };
const tokenStore = () => (localStorage.getItem("baas.token") ? localStorage : sessionStorage);

async function api(method, path, body, { raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${S.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    // During sign-in (no user yet) just report it; otherwise the session has ended.
    if (S.me) { logout(); throw new Error("Session expired. Please sign in again."); }
    throw new Error("That token was not accepted.");
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(data?.error || data?.message || `${res.status} ${res.statusText}`);
  return raw ? { res, data } : data;
}

const gwBase = (ref) => {
  const g = S.config?.gateway;
  if (!g) throw new Error("The data plane address is not configured.");
  return `${g.scheme}://${ref}.${g.domain}${g.port ? `:${g.port}` : ""}`;
};

/** Call the project's data plane with its service key (admins only). */
async function gw(path, { method = "GET", body, headers = {}, rawBody, key } = {}) {
  const k = key || S.keys?.service_role;
  if (!k) throw new Error("This action needs the service key, which requires the admin role.");
  const res = await fetch(`${gwBase(S.project.ref)}${path}`, {
    method,
    headers: { apikey: k, authorization: `Bearer ${k}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) throw new Error(data?.message || data?.msg || data?.error || `${res.status} ${res.statusText}`);
  return { data, res };
}

function logout() {
  localStorage.removeItem("baas.token");
  sessionStorage.removeItem("baas.token");
  S.token = S.me = S.project = S.keys = null;
  location.hash = "";
  route();
}

// ---------- shell ----------
function shell(...content) {
  const who = S.me ? `${S.me.organization.name} · ${S.me.role}` : "";
  return h("div", null,
    h("header", { class: "top" },
      h("a", { class: "brand", href: "#/projects" }, "baas", h("b", null, "."), " dashboard"),
      h("span", { class: "spacer" }),
      h("span", { class: "who", id: "who" }, who),
      h("button", { class: "ghost", onclick: logout }, "Sign out")),
    h("main", null, content));
}
const mount = (node) => { clear($app); $app.append(node); };

// ---------- login ----------
function renderLogin() {
  const err = h("div", { class: "notice bad", hidden: true, id: "login-error" });
  const token = h("input", { id: "token", name: "token", type: "password", autocomplete: "off", placeholder: "baas_…", required: true });
  const remember = h("input", { type: "checkbox", id: "remember" });
  const form = h("form", { class: "stack" },
    h("h1", null, "Sign in"),
    h("p", { class: "muted" }, "Paste an API token for your organisation. Tokens are created with the bootstrap secret or by an owner."),
    h("label", { class: "field" }, "API token", token),
    h("label", { class: "check" }, remember, "Remember on this device"),
    err,
    h("button", { class: "primary", type: "submit", id: "signin" }, "Sign in"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    S.token = token.value.trim();
    try {
      S.me = await api("GET", "/v1/me");
      (remember.checked ? localStorage : sessionStorage).setItem("baas.token", S.token);
      location.hash = "#/projects";
      route();
    } catch (ex) {
      S.token = null;
      err.hidden = false;
      err.textContent = ex.message;
    }
  });
  mount(h("div", { class: "login" }, h("div", { class: "card" }, form)));
}

// ---------- projects ----------
async function renderProjects() {
  const list = h("div", { class: "grid", id: "project-grid" }, h("p", { class: "muted" }, "Loading…"));
  const canCreate = S.me.role !== "developer";
  mount(shell(
    h("div", { class: "row between" }, h("h1", null, "Projects"),
      h("button", { class: "primary", id: "new-project", disabled: !canCreate, title: canCreate ? "" : "Requires the admin role", onclick: newProject }, "New project")),
    h("div", { class: "stack" }, list)));
  const rows = await api("GET", "/v1/projects");
  clear(list);
  if (!rows.length) list.append(h("div", { class: "empty card" }, "No projects yet. Create your first one."));
  for (const p of rows)
    list.append(h("a", { class: "card project-card", href: `#/p/${p.ref}/overview`, "data-ref": p.ref },
      h("h2", null, p.name), h("div", { class: "row" }, h("span", { class: `badge ${p.status}` }, p.status), h("span", { class: "badge" }, p.plan)),
      h("p", { class: "muted mono" }, p.ref), h("p", { class: "muted" }, `Created ${fmtDate(p.created_at)}`)));
}

async function newProject() {
  const r = await dialog("New project", () => h("label", { class: "field" }, "Project name", h("input", { name: "name", id: "project-name", required: true, maxlength: 80, placeholder: "my-app" })), {
    confirmLabel: "Create project",
    onSubmit: async (fd) => api("POST", "/v1/projects", { name: fd.get("name") }),
  });
  if (r) { toast(`Created ${r.name}`, "ok"); location.hash = `#/p/${r.ref}/overview`; }
}

// ---------- project shell ----------
const TABS = [
  ["overview", "Overview"], ["tables", "Table editor"], ["sql", "SQL editor"], ["ai", "Ask AI"], ["auth", "Authentication"], ["storage", "Storage"],
  ["functions", "Functions"], ["realtime", "Realtime"], ["logs", "Logs"], ["backups", "Backups"], ["settings", "Settings"],
];

async function renderProject(ref, tab) {
  if (!S.project || S.project.ref !== ref) {
    S.project = await api("GET", `/v1/projects/${ref}`);
    S.keys = await api("GET", `/v1/projects/${ref}/api-keys`);
    S.tables = null;
  }
  const p = S.project;
  const body = h("div", { id: "tab-body" }, h("p", { class: "muted" }, "Loading…"));
  mount(shell(
    h("div", { class: "row between" },
      h("div", null, h("a", { href: "#/projects", class: "muted" }, "← Projects"), h("h1", { id: "project-title" }, p.name, " ", h("span", { class: `badge ${p.status}`, id: "project-status" }, p.status)),
        h("div", { class: "muted mono" }, p.ref))),
    h("nav", { class: "tabs" }, TABS.map(([id, label]) => h("a", { href: `#/p/${ref}/${id}`, class: id === tab ? "on" : "", "data-tab": id }, label))),
    p.status === "paused" && h("div", { class: "notice warn" }, "This project is paused: its API is offline. Resume it in Settings."),
    body));
  const fn = { overview, tables, sql, ai, auth, storage, functions, realtime, logs, backups, settings }[tab] || overview;
  try {
    await fn(body, p);
  } catch (ex) {
    clear(body);
    body.append(h("div", { class: "notice bad" }, ex.message));
  }
}

async function refreshProject() {
  S.project = await api("GET", `/v1/projects/${S.project.ref}`);
  return S.project;
}

// ---------- overview ----------
function copyable(value, { secret = false } = {}) {
  const code = h("code", { class: "mono" }, secret ? "•".repeat(24) : value);
  let shown = !secret;
  const controls = [];
  if (secret) controls.push(h("button", { class: "small", onclick: (e) => { shown = !shown; code.textContent = shown ? value : "•".repeat(24); e.target.textContent = shown ? "Hide" : "Reveal"; } }, "Reveal"));
  controls.push(h("button", { class: "small", onclick: async () => { await navigator.clipboard?.writeText(value).catch(() => {}); toast("Copied"); } }, "Copy"));
  return [code, h("span", { class: "row" }, controls)];
}

function meter(label, used, limit) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const fill = h("i");
  fill.style.width = `${pct}%`;
  return h("div", { class: "meter" }, h("div", { class: "row between" }, h("span", null, label), h("span", { class: "muted" }, `${used.toLocaleString()} / ${limit.toLocaleString()}`)), h("div", { class: `bar ${pct > 90 ? "hot" : ""}` }, fill));
}

async function overview(body, p) {
  const [usage] = await Promise.all([api("GET", `/v1/projects/${p.ref}/usage`)]);
  const url = gwBase(p.ref);
  const today = usage.daily[0] || { requests: 0, errors: 0, egress_bytes: 0 };
  clear(body);
  body.append(h("div", { class: "stack" },
    h("div", { class: "card" }, h("h3", null, "Connect"),
      h("div", { class: "kv", id: "connect" },
        h("span", { class: "k" }, "Project URL"), ...copyable(url),
        h("span", { class: "k" }, "anon key"), ...copyable(S.keys.anon, { secret: true }),
        h("span", { class: "k" }, "service_role key"), ...(S.keys.service_role ? copyable(S.keys.service_role, { secret: true }) : [h("span", { class: "muted" }, "Requires the admin role"), h("span")]))),
    h("div", { class: "card" }, h("h3", null, "Use it"),
      h("pre", null, `import { createClient } from "baas/client";\nconst baas = createClient("${url}", "<anon key>");\nawait baas.from("todos").select("*");`),
      h("p", { class: "muted" }, "The service_role key bypasses row-level security. Keep it on servers only.")),
    h("div", { class: "card stack", id: "usage" }, h("h3", null, `Usage · ${usage.plan} plan`),
      meter("Requests today", Number(today.requests), usage.limits.requestsPerDay),
      meter("Database size", Number(usage.current?.db_bytes || 0), usage.limits.dbBytes),
      meter("Storage", Number(usage.current?.storage_bytes || 0), usage.limits.storageBytes),
      h("p", { class: "muted" }, `${Number(today.errors)} server error${Number(today.errors) === 1 ? "" : "s"} · ${fmtBytes(today.egress_bytes)} sent today · ${usage.limits.rps} requests/second`),
      usage.over_db_quota && h("div", { class: "notice bad" }, "The database is over its size limit: writes through the API are blocked until you delete data or upgrade."))));
}

// ---------- table editor ----------
const TYPES = { text: "text", "integer": "int4", "bigint": "int8", "boolean": "bool", "timestamp": "timestamptz", "uuid": "uuid", "json": "jsonb", "decimal": "numeric", "float": "float8", "date": "date" };
// An ordered list, not an object: integer-like keys such as "0" would jump to the front of an object.
const DEFAULTS = [["no default", ""], ["gen_random_uuid()", "gen_random_uuid()"], ["now()", "now()"], ["0", "0"], ["true", "true"], ["false", "false"], ["empty text", "''"]];
let TSTATE = { table: null, offset: 0, limit: 50 };

async function loadTables() {
  S.tables = await api("GET", `/v1/projects/${S.project.ref}/tables`);
  return S.tables;
}

function convert(value, type) {
  if (value === "") return undefined;
  if (/^(int|numeric|float|smallint|bigint|double|real|decimal)/.test(type)) { const n = Number(value); if (Number.isNaN(n)) throw new Error(`"${value}" is not a number`); return n; }
  if (/^bool/.test(type)) return value === "true" || value === "t" || value === "1";
  if (/json/.test(type)) { try { return JSON.parse(value); } catch { throw new Error("Invalid JSON"); } }
  return value;
}

const cellText = (v) => (v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v));

async function tables(body) {
  const tabs = S.tables || (await loadTables());
  if (!TSTATE.table || !tabs.some((t) => t.name === TSTATE.table)) TSTATE = { table: tabs[0]?.name || null, offset: 0, limit: 50 };
  clear(body);
  const side = h("div", { class: "side", id: "table-list" },
    tabs.map((t) => h("button", { class: `item ${t.name === TSTATE.table ? "on" : ""}`, "data-table": t.name, onclick: () => { TSTATE = { table: t.name, offset: 0, limit: 50 }; tables(body); } },
      h("span", null, t.name), !t.rls && h("span", { class: "warn", title: "Row-level security is off" }, "RLS off"))),
    h("button", { class: "item", id: "new-table", onclick: async () => { if (await createTableDialog()) { await loadTables(); TSTATE.table = null; tables(body); } } }, "+ New table"));
  const main = h("div", { class: "stack", id: "table-main" });
  body.append(h("div", { class: "split" }, side, main));
  if (!TSTATE.table) { main.append(h("div", { class: "empty card" }, "No tables yet. Create one to get started.")); return; }
  await renderRows(main, tabs.find((t) => t.name === TSTATE.table), body);
}

async function renderRows(main, t, body) {
  const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
  const order = pk.length ? `&order=${pk.map((c) => `${c}.asc`).join(",")}` : "";
  let rows = [];
  let total = null;
  let error = null;
  try {
    const { data, res } = await gw(`/rest/v1/${t.name}?limit=${TSTATE.limit}&offset=${TSTATE.offset}${order}`, { headers: { prefer: "count=exact" } });
    rows = data;
    total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") || "")?.[1] ?? rows.length);
  } catch (ex) { error = ex.message; }

  const head = h("div", { class: "row between" },
    h("div", null, h("h2", { id: "table-name" }, t.name), h("span", { class: "muted" }, `${t.columns.length} columns · ${t.policies} polic${t.policies === 1 ? "y" : "ies"} · RLS ${t.rls ? "on" : "off"}`)),
    h("div", { class: "row" },
      !t.rls && h("button", { onclick: async () => { await sqlRun(`ALTER TABLE public.${qi(t.name)} ENABLE ROW LEVEL SECURITY`); toast("RLS enabled", "ok"); await loadTables(); tables(body); } }, "Enable RLS"),
      h("button", { id: "insert-row", class: "primary", onclick: async () => { if (await insertRowDialog(t)) renderRows(main, t, body); } }, "Insert row"),
      h("button", { class: "danger", onclick: async () => { if (await confirmBox("Drop table", `This permanently deletes "${t.name}" and all its rows.`, { typed: t.name, confirmLabel: "Drop table" })) { await sqlRun(`DROP TABLE public.${qi(t.name)}`); toast("Table dropped", "ok"); await loadTables(); TSTATE.table = null; tables(body); } } }, "Drop")));
  clear(main);
  main.append(head);
  if (error) { main.append(h("div", { class: "notice bad" }, error)); return; }
  if (!pk.length) main.append(h("div", { class: "notice warn" }, "This table has no primary key, so rows cannot be edited or deleted here."));
  const wrap = h("div", { class: "tablewrap" });
  if (!rows.length) wrap.append(h("div", { class: "empty" }, "This table is empty."));
  else {
    const tbl = h("table", { class: "data", id: "rows" },
      h("thead", null, h("tr", null, t.columns.map((c) => h("th", { title: c.type }, c.name, c.pk && " 🔑")), pk.length && h("th"))),
      h("tbody", null, rows.map((row) => h("tr", null,
        t.columns.map((c) => cell(t, c, row, pk, () => renderRows(main, t, body))),
        pk.length && h("td", null, h("button", { class: "small danger", "data-action": "delete-row", onclick: async () => {
          if (!(await confirmBox("Delete row", "This cannot be undone.", { confirmLabel: "Delete" }))) return;
          try { await gw(`/rest/v1/${t.name}?${pkFilter(pk, row)}`, { method: "DELETE" }); toast("Row deleted", "ok"); renderRows(main, t, body); } catch (ex) { toast(ex.message, "bad"); }
        } }, "Delete"))))));
    wrap.append(tbl);
  }
  main.append(wrap);
  main.append(h("div", { class: "row between" },
    h("span", { class: "muted", id: "row-count" }, `${total} row${total === 1 ? "" : "s"}`),
    h("div", { class: "row" },
      h("button", { disabled: TSTATE.offset === 0, onclick: () => { TSTATE.offset = Math.max(0, TSTATE.offset - TSTATE.limit); renderRows(main, t, body); } }, "Previous"),
      h("button", { disabled: TSTATE.offset + TSTATE.limit >= total, onclick: () => { TSTATE.offset += TSTATE.limit; renderRows(main, t, body); } }, "Next"))));
}

const pkFilter = (pk, row) => pk.map((c) => `${encodeURIComponent(c)}=eq.${encodeURIComponent(row[c])}`).join("&");

function cell(t, c, row, pk, reload) {
  const v = row[c.name];
  const td = h("td", { class: v === null ? "null" : "", title: cellText(v).slice(0, 500) }, truncate(cellText(v), 80));
  if (!pk.length || c.pk) return td;
  td.addEventListener("dblclick", () => {
    const input = h("input", { value: v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v), "aria-label": `Edit ${c.name}` });
    td.className = "editing";
    clear(td);
    td.append(input);
    input.focus();
    input.select();
    let done = false;
    const save = async () => {
      if (done) return;
      done = true;
      try {
        let val = convert(input.value, c.type);
        if (val === undefined) val = c.nullable ? null : "";
        if (val !== v) { await gw(`/rest/v1/${t.name}?${pkFilter(pk, row)}`, { method: "PATCH", body: { [c.name]: val } }); toast("Saved", "ok"); }
      } catch (ex) { toast(ex.message, "bad"); }
      reload();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { done = true; reload(); } });
    input.addEventListener("blur", save);
  });
  return td;
}

async function insertRowDialog(t) {
  return dialog(`Insert into ${t.name}`, () => h("div", { class: "stack" }, t.columns.map((c) =>
    h("label", { class: "field" }, `${c.name} · ${c.type}${c.default ? ` (default ${c.default})` : ""}${c.nullable ? "" : " · required"}`, h("input", { name: c.name, autocomplete: "off", placeholder: c.default ? "leave empty for default" : c.nullable ? "NULL" : "" })))), {
    confirmLabel: "Insert",
    onSubmit: async (fd) => {
      const row = {};
      for (const c of t.columns) { const val = convert(String(fd.get(c.name) ?? ""), c.type); if (val !== undefined) row[c.name] = val; }
      await gw(`/rest/v1/${t.name}`, { method: "POST", body: row });
      toast("Row inserted", "ok");
      return true;
    },
  });
}

async function createTableDialog() {
  const colRows = h("div", { class: "stack", id: "col-rows" });
  const addCol = (name = "", type = "text", pk = false) => {
    colRows.append(h("div", { class: "row col-row" },
      h("input", { name: "cname", placeholder: "column_name", value: name, "aria-label": "Column name" }),
      h("select", { name: "ctype", "aria-label": "Type" }, Object.entries(TYPES).map(([label, sql]) => h("option", { value: sql, selected: sql === type }, label))),
      h("select", { name: "cdef", "aria-label": "Default" }, DEFAULTS.map(([label]) => h("option", { value: label }, label))),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "cpk", checked: pk }), "PK"),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "cnull", checked: !pk }), "null")));
  };
  addCol("id", "int8", true);
  addCol("title", "text");
  return dialog("New table", () => h("div", { class: "stack" },
    h("label", { class: "field" }, "Table name", h("input", { name: "tname", id: "tname", required: true, placeholder: "todos" })),
    h("h3", null, "Columns"), colRows,
    h("button", { type: "button", onclick: () => addCol() }, "+ Add column"),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "rls", checked: true }), "Enable row-level security (recommended)"),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "expose", checked: true }), "Allow the API roles (anon, authenticated) to use this table"),
    h("p", { class: "muted" }, "With RLS on and no policies, only the service key can read the table. Add policies in the SQL editor.")), {
    confirmLabel: "Create table",
    onSubmit: async (fd, form) => {
      const name = String(fd.get("tname"));
      if (!ident(name)) throw new Error("Table names use lowercase letters, digits and underscores, and must not start with a digit.");
      const rows = [...form.querySelectorAll(".col-row")];
      const defs = [];
      const pks = [];
      for (const r of rows) {
        const cn = r.querySelector("[name=cname]").value.trim();
        if (!cn) continue;
        if (!ident(cn)) throw new Error(`Invalid column name: ${cn}`);
        const type = r.querySelector("[name=ctype]").value;
        const isPk = r.querySelector("[name=cpk]").checked;
        const nullable = r.querySelector("[name=cnull]").checked && !isPk;
        const def = DEFAULTS.find(([label]) => label === r.querySelector("[name=cdef]").value)[1];
        const identity = isPk && (type === "int4" || type === "int8") && !def;
        defs.push(`${qi(cn)} ${type}${identity ? " GENERATED BY DEFAULT AS IDENTITY" : ""}${def ? ` DEFAULT ${def}` : ""}${nullable ? "" : " NOT NULL"}`);
        if (isPk) pks.push(qi(cn));
      }
      if (!defs.length) throw new Error("Add at least one column.");
      if (pks.length) defs.push(`PRIMARY KEY (${pks.join(", ")})`);
      let q = `CREATE TABLE public.${qi(name)} (${defs.join(", ")});`;
      if (fd.get("rls")) q += ` ALTER TABLE public.${qi(name)} ENABLE ROW LEVEL SECURITY;`;
      if (fd.get("expose")) q += ` GRANT SELECT, INSERT, UPDATE, DELETE ON public.${qi(name)} TO anon, authenticated;`;
      await sqlRun(q);
      toast(`Created ${name}`, "ok");
      return true;
    },
  });
}

// ---------- SQL editor ----------
async function sqlRun(query) {
  return (await api("POST", `/v1/projects/${S.project.ref}/sql`, { query })).results;
}

const SNIPPETS = {
  "Snippets…": "",
  "Create a table": "create table public.todos (\n  id bigint generated by default as identity primary key,\n  owner uuid default auth.uid(),\n  title text not null,\n  done boolean not null default false\n);\nalter table public.todos enable row level security;\ngrant select, insert, update, delete on public.todos to authenticated;",
  "Owner-only policy": "create policy \"owner can do everything\" on public.todos\n  for all to authenticated\n  using (owner = auth.uid()) with check (owner = auth.uid());",
  "Public read policy": "grant select on public.todos to anon;\ncreate policy \"anyone can read\" on public.todos for select to anon using (true);",
  "Storage policy": "create policy \"authenticated can read files\" on storage.objects\n  for select to authenticated using (bucket_id = 'files');",
  "List tables": "select table_name from information_schema.tables where table_schema = 'public' order by 1;",
};

function resultTable(r) {
  if (!r.fields.length) return h("div", { class: "notice" }, `${r.command}${r.rowCount ? ` · ${r.rowCount} row${r.rowCount === 1 ? "" : "s"}` : ""}`);
  return h("div", null,
    h("div", { class: "tablewrap" }, h("table", { class: "data result" },
      h("thead", null, h("tr", null, r.fields.map((f) => h("th", null, f)))),
      h("tbody", null, r.rows.map((row) => h("tr", null, row.map((v) => h("td", { class: v === null ? "null" : "" }, truncate(cellText(v), 120)))))))),
    h("p", { class: "muted" }, `${r.rows.length}${r.truncated ? "+" : ""} row${r.rows.length === 1 ? "" : "s"}${r.truncated ? " (output truncated)" : ""}`));
}

async function sql(body) {
  const hist = JSON.parse(sessionStorage.getItem("baas.sql.history") || "[]");
  const editor = h("textarea", { class: "code editor", id: "sql-input", spellcheck: "false", placeholder: "select now();" }, hist[0] || "");
  const out = h("div", { class: "stack", id: "sql-output" });
  const run = async () => {
    const q = editor.value;
    if (!q.trim()) return;
    out.replaceChildren(h("p", { class: "muted" }, "Running…"));
    const t0 = performance.now();
    try {
      const results = await sqlRun(q);
      S.tables = null;
      sessionStorage.setItem("baas.sql.history", JSON.stringify([q, ...hist.filter((x) => x !== q)].slice(0, 20)));
      out.replaceChildren(h("p", { class: "muted" }, `Finished in ${Math.round(performance.now() - t0)} ms`), ...results.map(resultTable));
    } catch (ex) {
      out.replaceChildren(h("div", { class: "notice bad", id: "sql-error" }, ex.message));
    }
  };
  editor.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); } });
  const snip = h("select", { "aria-label": "Snippets", onchange: (e) => { const s = SNIPPETS[e.target.value]; if (s) editor.value = s; e.target.selectedIndex = 0; } }, Object.keys(SNIPPETS).map((k) => h("option", null, k)));
  clear(body);
  body.append(h("div", { class: "stack" },
    h("div", { class: "row between" }, h("h2", null, "SQL editor"), h("div", { class: "row" }, snip, h("button", { id: "run-sql", class: "primary", onclick: run }, "Run ⌘/Ctrl+Enter"))),
    h("p", { class: "muted" }, "Runs as the project's service_role in one transaction. Nothing is exposed through the API until you grant it to anon or authenticated."),
    editor, out,
    hist.length > 1 && h("details", null, h("summary", null, "History"), hist.slice(1).map((q) => h("pre", { class: "clickable", onclick: () => { editor.value = q; } }, truncate(q, 300))))));
}

// ---------- Ask AI ----------
// Conversation state per project, kept while the page stays open.
let AI = { ref: null, entries: [] };

function proposalCard(pr, entry) {
  const state = h("div", { class: "muted" });
  const run = h("button", { class: pr.risk.destructive ? "danger" : "primary", "data-action": "run-proposal" }, "Run this SQL");
  const done = (msg, kind) => { run.disabled = true; state.textContent = msg; state.className = kind; };
  run.addEventListener("click", async () => {
    const ok = await dialog("Run AI-proposed SQL?", () => h("div", { class: "stack" },
      h("p", null, "This SQL was written by an AI model. Read it before running; it changes your database."),
      h("pre", null, pr.sql),
      pr.risk.flags.length && h("ul", { class: pr.risk.destructive ? "bad" : "" }, pr.risk.flags.map((f) => h("li", null, f))),
      pr.risk.destructive && h("label", { class: "field" }, 'Type "run" to confirm', h("input", { name: "typed", autocomplete: "off", id: "confirm-run" }))), {
      confirmLabel: "Run it", danger: pr.risk.destructive,
      onSubmit: (fd) => { if (pr.risk.destructive && String(fd.get("typed")).trim().toLowerCase() !== "run") throw new Error('Type "run" to confirm.'); return true; },
    });
    if (!ok) return;
    try {
      const results = await sqlRun(pr.sql);
      S.tables = null;
      done(`Ran. ${results.map((r) => `${r.command}${r.rowCount ? ` ${r.rowCount}` : ""}`).join(", ")}`, "ok");
      toast("Change applied", "ok");
    } catch (ex) { state.textContent = ex.message; state.className = "bad"; toast(ex.message, "bad"); }
  });
  const dismiss = h("button", { onclick: () => { done("Dismissed. Nothing was run.", "muted"); } }, "Dismiss");
  const v = pr.validation;
  return h("div", { class: `proposal ${pr.risk.destructive ? "destructive" : ""}`, "data-proposal": "1" },
    h("div", { class: "row between" }, h("strong", null, "Proposed change — not run yet"), h("span", { class: `badge ${v.status === "invalid" ? "failed" : ""}` }, v.status === "ok" ? "checked by the database" : v.status === "unchecked" ? `not pre-checked: ${v.message || ""}` : "invalid")),
    h("div", null, h("span", { class: "muted" }, "What it will do (detected from the SQL): "), pr.risk.flags.map((f, i) => h("span", { class: `badge ${pr.risk.destructive ? "failed" : ""}`, "data-risk": "1" }, f))),
    pr.explanation && h("p", null, h("span", { class: "muted" }, "The assistant says: "), pr.explanation),
    h("pre", { class: "sql" }, pr.sql),
    h("div", { class: "row" }, run, h("button", { onclick: async () => { await navigator.clipboard?.writeText(pr.sql).catch(() => {}); toast("Copied"); } }, "Copy"), dismiss, state));
}

function stepView(st) {
  return h("details", { class: "step", "data-step": st.tool },
    h("summary", null, st.tool === "run_query" ? (st.purpose || "Query") : "Proposed change", " ", st.ok ? h("span", { class: "muted" }, st.tool === "run_query" ? `· ${st.rowCount} row${st.rowCount === 1 ? "" : "s"}${st.moreRows ? "+" : ""} · ${st.ms} ms` : "") : h("span", { class: "bad" }, "· failed")),
    h("pre", { class: "sql" }, st.sql),
    st.error && h("div", { class: "notice bad" }, st.error),
    st.ok && st.columns && (st.rows.length ? h("div", { class: "tablewrap" }, h("table", { class: "data" }, h("thead", null, h("tr", null, st.columns.map((c) => h("th", null, c)))), h("tbody", null, st.rows.map((r) => h("tr", null, r.map((v) => h("td", { class: v === null ? "null" : "" }, truncate(cellText(v), 80)))))))) : h("p", { class: "muted" }, "No rows.")));
}

function entryView(e) {
  const box = h("div", { class: "entry" }, h("div", { class: "bubble user" }, e.question));
  if (e.pending) box.append(h("div", { class: "bubble ai muted", "data-pending": "1" }, "Thinking…"));
  else if (e.error) box.append(h("div", { class: "notice bad", "data-ai-error": "1" }, e.error));
  else {
    const r = e.result;
    box.append(h("div", { class: "bubble ai", "data-answer": "1" }, r.answer));
    if (r.steps.length) box.append(h("div", { class: "steps" }, r.steps.filter((s) => s.tool === "run_query").length ? h("p", { class: "muted" }, "Queries the assistant ran (read-only):") : null, r.steps.filter((s) => s.tool === "run_query").map(stepView)));
    r.proposals.forEach((pr) => box.append(proposalCard(pr, e)));
  }
  return box;
}

async function ai(body, p) {
  if (AI.ref !== p.ref) AI = { ref: p.ref, entries: [] };
  const st = await api("GET", `/v1/projects/${p.ref}/ai`);
  clear(body);
  if (!st.available) {
    body.append(h("div", { class: "notice", id: "ai-unavailable" }, "The assistant is not available: this server has no AI provider configured. The server operator can enable it by setting ANTHROPIC_API_KEY."));
    return;
  }
  const canAdmin = S.me.role !== "developer";
  if (!st.enabled) {
    body.append(h("div", { class: "card stack", id: "ai-off" },
      h("h2", null, "Ask questions about your data in plain language"),
      h("p", null, "The assistant writes and runs read-only SQL to answer, and can propose changes that you review and run yourself. It never changes anything on its own."),
      h("div", { class: "notice warn", id: "ai-notice" }, st.notice),
      h("p", { class: "muted" }, "It can read the tables in your public schema (including rows protected by row-level security, like the SQL editor), but not users, sessions, files or other internals."),
      h("button", { class: "primary", id: "ai-enable", disabled: !canAdmin, title: canAdmin ? "" : "Requires the admin role", onclick: async () => {
        if (!(await confirmBox("Enable the AI assistant?", st.notice, { danger: false, confirmLabel: "Enable" }))) return;
        try { await api("POST", `/v1/projects/${p.ref}/ai/enable`); toast("AI assistant enabled", "ok"); ai(body, p); } catch (ex) { toast(ex.message, "bad"); }
      } }, "Enable for this project")));
    return;
  }
  const list = h("div", { class: "chat", id: "ai-chat" });
  const input = h("textarea", { id: "ai-input", rows: 2, placeholder: "e.g. Which customers spent the most this month?", maxlength: 2000 });
  const send = h("button", { class: "primary", id: "ai-send" }, "Ask");
  const counter = h("span", { class: "muted", id: "ai-quota" }, `${st.questionsToday} of ${st.questionsPerDay} questions used today · ${st.model}`);
  const draw = () => { clear(list); if (!AI.entries.length) list.append(h("p", { class: "muted" }, "Ask about your tables. Try “How many rows are in each table?”")); AI.entries.forEach((e) => list.append(entryView(e))); list.scrollTop = list.scrollHeight; };
  const submit = async () => {
    const q = input.value.trim();
    if (!q || send.disabled) return;
    const history = [];
    for (const e of AI.entries.slice(-5)) if (e.result) { history.push({ role: "user", content: e.question }, { role: "assistant", content: e.result.answer }); }
    const entry = { question: q, pending: true };
    AI.entries.push(entry);
    input.value = "";
    send.disabled = true;
    draw();
    try {
      entry.result = await api("POST", `/v1/projects/${p.ref}/ai/ask`, { question: q, history });
      const st2 = await api("GET", `/v1/projects/${p.ref}/ai`);
      counter.textContent = `${st2.questionsToday} of ${st2.questionsPerDay} questions used today · ${st2.model}`;
    } catch (ex) { entry.error = ex.message; }
    entry.pending = false;
    send.disabled = false;
    draw();
    input.focus();
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); } });
  body.append(h("div", { class: "stack" },
    h("div", { class: "row between" }, h("h2", null, "Ask AI"), h("div", { class: "row" }, counter,
      h("button", { class: "small", onclick: () => { AI.entries = []; draw(); } }, "Clear chat"),
      h("button", { class: "small", id: "ai-disable", disabled: !canAdmin, onclick: async () => { if (await confirmBox("Turn off the assistant?", "The assistant loses its read access to this database.", { danger: false, confirmLabel: "Turn off" })) { await api("POST", `/v1/projects/${p.ref}/ai/disable`); AI.entries = []; ai(body, p); } } }, "Turn off"))),
    list,
    h("div", { class: "stack" }, input, h("div", { class: "row between" }, h("span", { class: "muted" }, "Your question, the table structure and query results are sent to Anthropic. Ctrl/⌘+Enter to send."), send))));
  draw();
}

// ---------- authentication ----------
async function auth(body) {
  const load = async () => (await gw("/auth/v1/admin/users?per_page=100")).data;
  let { users, total } = await load();
  const draw = () => {
    clear(body);
    body.append(h("div", { class: "stack" },
      h("div", { class: "row between" }, h("h2", null, "Users ", h("span", { class: "muted", id: "user-count" }, `(${total})`)),
        h("button", { class: "primary", id: "new-user", onclick: async () => {
          const u = await dialog("Create user", () => h("div", { class: "stack" },
            h("label", { class: "field" }, "Email", h("input", { name: "email", type: "email", required: true, id: "user-email" })),
            h("label", { class: "field" }, "Password", h("input", { name: "password", type: "password", required: true, minlength: 6, id: "user-password" }))), {
            confirmLabel: "Create user", onSubmit: async (fd) => (await gw("/auth/v1/admin/users", { method: "POST", body: { email: fd.get("email"), password: fd.get("password") } })).data,
          });
          if (u) { toast("User created", "ok"); ({ users, total } = await load()); draw(); }
        } }, "Create user")),
      h("div", { class: "tablewrap" }, users.length
        ? h("table", { class: "data", id: "users" },
          h("thead", null, h("tr", null, ["Email", "ID", "Created", "Last sign in", "Status", ""].map((x) => h("th", null, x)))),
          h("tbody", null, users.map((u) => h("tr", { "data-email": u.email },
            h("td", null, u.email), h("td", { class: "mono" }, u.id), h("td", null, fmtDate(u.created_at)), h("td", null, fmtDate(u.last_sign_in_at)),
            h("td", null, u.banned_until && new Date(u.banned_until) > new Date() ? h("span", { class: "bad" }, "banned") : "active"),
            h("td", { class: "row" },
              h("button", { class: "small", onclick: async () => { const banned = u.banned_until && new Date(u.banned_until) > new Date(); await gw(`/auth/v1/admin/users/${u.id}`, { method: "PUT", body: { ban_duration: banned ? "none" : "876000h" } }); toast(banned ? "User unbanned" : "User banned", "ok"); ({ users, total } = await load()); draw(); } }, u.banned_until && new Date(u.banned_until) > new Date() ? "Unban" : "Ban"),
              h("button", { class: "small danger", "data-action": "delete-user", onclick: async () => { if (await confirmBox("Delete user", `Delete ${u.email}? Their sessions end immediately.`, { confirmLabel: "Delete" })) { await gw(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" }); toast("User deleted", "ok"); ({ users, total } = await load()); draw(); } } }, "Delete"))))))
        : h("div", { class: "empty" }, "No users yet. They appear here when someone signs up through the API."))));
  };
  draw();
}

// ---------- storage ----------
let SSTATE = { bucket: null, prefix: "" };

async function storage(body) {
  const buckets = (await gw("/storage/v1/bucket")).data;
  if (!SSTATE.bucket || !buckets.some((b) => b.id === SSTATE.bucket)) SSTATE = { bucket: buckets[0]?.id ?? null, prefix: "" };
  clear(body);
  const side = h("div", { class: "side", id: "bucket-list" },
    buckets.map((b) => h("button", { class: `item ${b.id === SSTATE.bucket ? "on" : ""}`, "data-bucket": b.id, onclick: () => { SSTATE = { bucket: b.id, prefix: "" }; storage(body); } }, h("span", null, b.id), h("span", { class: "muted" }, b.public ? "public" : "private"))),
    h("button", { class: "item", id: "new-bucket", onclick: async () => {
      const r = await dialog("New bucket", () => h("div", { class: "stack" },
        h("label", { class: "field" }, "Name", h("input", { name: "id", id: "bucket-name", required: true, pattern: "[A-Za-z0-9._\\-]{1,63}" })),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "public", id: "bucket-public" }), "Public bucket (files readable by anyone with the URL)")), {
        confirmLabel: "Create bucket", onSubmit: async (fd) => gw("/storage/v1/bucket", { method: "POST", body: { id: fd.get("id"), public: fd.get("public") === "on" } }),
      });
      if (r) { toast("Bucket created", "ok"); SSTATE = { bucket: r.data.name, prefix: "" }; storage(body); }
    } }, "+ New bucket"));
  const main = h("div", { class: "stack", id: "storage-main" });
  body.append(h("div", { class: "split" }, side, main));
  if (!SSTATE.bucket) { main.append(h("div", { class: "empty card" }, "No buckets yet. Create one to store files.")); return; }
  await renderObjects(main, body);
}

async function renderObjects(main, body) {
  const { bucket, prefix } = SSTATE;
  const items = (await gw(`/storage/v1/object/list/${encodeURIComponent(bucket)}`, { method: "POST", body: { prefix, limit: 200 } })).data;
  const parts = prefix.split("/").filter(Boolean);
  const crumbs = h("div", { class: "crumbs", id: "crumbs" }, h("a", { href: "#", onclick: (e) => { e.preventDefault(); SSTATE.prefix = ""; storage(body); } }, bucket),
    parts.map((seg, i) => [" / ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); SSTATE.prefix = parts.slice(0, i + 1).join("/"); storage(body); } }, seg)]));
  const fileInput = h("input", { type: "file", id: "upload-input", class: "hidden-input" });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const path = [...parts, f.name].join("/");
      await gw(`/storage/v1/object/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", rawBody: f, headers: { "content-type": f.type || "application/octet-stream", "x-upsert": "true" } });
      toast(`Uploaded ${f.name}`, "ok");
      renderObjects(main, body);
    } catch (ex) { toast(ex.message, "bad"); }
  });
  clear(main);
  main.append(
    h("div", { class: "row between" }, h("h2", null, bucket), h("div", { class: "row" },
      h("label", { class: "btn primary upload" }, "Upload file", fileInput),
      h("button", { class: "danger", id: "delete-bucket", onclick: async () => {
        if (!(await confirmBox("Delete bucket", `Delete "${bucket}" and every file in it?`, { typed: bucket, confirmLabel: "Delete bucket" }))) return;
        await gw(`/storage/v1/bucket/${encodeURIComponent(bucket)}/empty`, { method: "POST" });
        await gw(`/storage/v1/bucket/${encodeURIComponent(bucket)}`, { method: "DELETE" });
        toast("Bucket deleted", "ok"); SSTATE.bucket = null; storage(body);
      } }, "Delete bucket"))),
    crumbs,
    h("div", { class: "tablewrap" }, items.length ? h("table", { class: "data", id: "objects" },
      h("thead", null, h("tr", null, ["Name", "Size", "Type", "Updated", ""].map((x) => h("th", null, x)))),
      h("tbody", null, items.map((o) => {
        const isFolder = o.id === null;
        const full = [...parts, o.name].join("/");
        return h("tr", { "data-name": o.name },
          h("td", null, isFolder ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); SSTATE.prefix = full; storage(body); } }, `📁 ${o.name}`) : o.name),
          h("td", null, isFolder ? "—" : fmtBytes(o.metadata?.size)), h("td", null, isFolder ? "" : o.metadata?.mimetype || ""), h("td", null, fmtDate(o.updated_at)),
          h("td", { class: "row" }, !isFolder && [
            h("button", { class: "small", "data-action": "download", onclick: async () => {
              const res = await fetch(`${gwBase(S.project.ref)}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${full.split("/").map(encodeURIComponent).join("/")}`, { headers: { apikey: S.keys.service_role, authorization: `Bearer ${S.keys.service_role}` } });
              if (!res.ok) return toast("Download failed", "bad");
              const a = h("a", { href: URL.createObjectURL(await res.blob()), download: o.name });
              document.body.append(a); a.click(); a.remove();
            } }, "Download"),
            h("button", { class: "small", onclick: async () => {
              const { data } = await gw(`/storage/v1/object/sign/${encodeURIComponent(bucket)}/${full.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", body: { expiresIn: 3600 } });
              await dialog("Signed URL (valid 1 hour)", () => h("textarea", { class: "code", readonly: true, rows: 4 }, `${gwBase(S.project.ref)}/storage/v1${data.signedURL}`), { confirmLabel: "Close" });
            } }, "Share"),
            h("button", { class: "small danger", "data-action": "delete-object", onclick: async () => {
              if (!(await confirmBox("Delete file", `Delete ${o.name}?`, { confirmLabel: "Delete" }))) return;
              await gw(`/storage/v1/object/${encodeURIComponent(bucket)}`, { method: "DELETE", body: { prefixes: [full] } });
              toast("File deleted", "ok"); renderObjects(main, body);
            } }, "Delete")]));
      }))) : h("div", { class: "empty" }, "This folder is empty.")));
}

// ---------- functions ----------
const FN_TEMPLATE = `// Runs in an isolated Node process. Export a default handler that takes a Request and returns a Response.
export default async function handler(req) {
  const { name = "world" } = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  return Response.json({ message: \`Hello \${name}!\`, project: process.env.SUPABASE_URL });
}
`;

async function functions(body) {
  const list = await api("GET", `/v1/projects/${S.project.ref}/functions`);
  const nameIn = h("input", { id: "fn-name", placeholder: "hello-world", pattern: "[a-z0-9][a-z0-9\\-]{0,39}" });
  const src = h("textarea", { class: "code editor", id: "fn-source", spellcheck: "false", rows: 12 }, FN_TEMPLATE);
  const verify = h("input", { type: "checkbox", id: "fn-verify", checked: true });
  const out = h("pre", { id: "fn-result", hidden: true });
  const logs = h("div", { id: "fn-logs" });
  const testBody = h("input", { id: "fn-body", value: '{"name":"dashboard"}' });
  const load = async (name) => {
    const f = await api("GET", `/v1/projects/${S.project.ref}/functions/${name}`);
    nameIn.value = f.name; src.value = f.source; verify.checked = f.verify_jwt;
    showLogs(name);
  };
  const showLogs = async (name) => {
    const rows = await api("GET", `/v1/projects/${S.project.ref}/functions/${name}/logs`).catch(() => []);
    clear(logs);
    logs.append(h("h3", null, "Recent invocations"), rows.length ? h("table", { class: "data" }, h("tbody", null, rows.slice(0, 20).map((l) => h("tr", null, h("td", null, fmtDate(l.at)), h("td", { class: l.status >= 500 ? "bad" : "" }, l.status), h("td", null, `${l.ms} ms`), h("td", null, l.note || ""))))) : h("p", { class: "muted" }, "None yet."));
  };
  clear(body);
  body.append(h("div", { class: "split" },
    h("div", { class: "side", id: "fn-list" }, list.map((f) => h("button", { class: "item", "data-fn": f.name, onclick: () => load(f.name) }, h("span", null, f.name), h("span", { class: "muted" }, `v${f.version}`))),
      h("button", { class: "item", onclick: () => { nameIn.value = ""; src.value = FN_TEMPLATE; clear(logs); nameIn.focus(); } }, "+ New function")),
    h("div", { class: "stack" },
      h("div", { class: "row" }, h("label", { class: "field" }, "Function name", nameIn), h("label", { class: "check" }, verify, "Require a valid API key (verify JWT)")),
      src,
      h("div", { class: "row" },
        h("button", { class: "primary", id: "fn-deploy", onclick: async () => {
          try {
            const r = await api("PUT", `/v1/projects/${S.project.ref}/functions/${nameIn.value}`, { source: src.value, verify_jwt: verify.checked });
            toast(`Deployed ${r.name} v${r.version}`, "ok"); functions(body);
          } catch (ex) { toast(ex.message, "bad"); }
        } }, "Deploy"),
        h("button", { class: "danger", onclick: async () => { if (nameIn.value && await confirmBox("Delete function", `Delete ${nameIn.value}?`)) { await api("DELETE", `/v1/projects/${S.project.ref}/functions/${nameIn.value}`); functions(body); } } }, "Delete")),
      h("div", { class: "card stack" }, h("h3", null, "Test invocation"),
        h("div", { class: "row" }, testBody, h("button", { id: "fn-invoke", onclick: async () => {
          out.hidden = false; out.textContent = "Running…";
          try {
            const res = await fetch(`${gwBase(S.project.ref)}/functions/v1/${nameIn.value}`, { method: "POST", headers: { apikey: S.keys.anon, authorization: `Bearer ${S.keys.anon}`, "content-type": "application/json" }, body: testBody.value });
            out.textContent = `${res.status}\n${await res.text()}`;
            showLogs(nameIn.value);
          } catch (ex) { out.textContent = ex.message; }
        } }, "Invoke")), out),
      logs)));
}

// ---------- realtime inspector ----------
let RT = null;

async function realtime(body) {
  const tabs = S.tables || (await loadTables());
  const select = h("select", { id: "rt-table" }, tabs.map((t) => h("option", { value: t.name }, t.name)));
  const status = h("span", { class: "muted", id: "rt-status" }, "not listening");
  const feed = h("div", { class: "events stack", id: "rt-events" });
  const stop = () => { RT?.close(); RT = null; status.textContent = "not listening"; };
  const start = () => {
    stop();
    if (!select.value) return;
    const g = S.config.gateway;
    const ws = new WebSocket(`${g.scheme === "https" ? "wss" : "ws"}://${S.project.ref}.${g.domain}${g.port ? `:${g.port}` : ""}/realtime/v1/websocket?apikey=${encodeURIComponent(S.keys.service_role)}`);
    RT = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", ref: "inspector", table: select.value, event: "*" }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "subscribed") status.textContent = `listening to ${select.value}`;
      if (m.type === "error") status.textContent = `error: ${m.message}`;
      if (m.type === "change") { feed.prepend(h("pre", { class: "event" }, `${m.event} ${m.table}\n${JSON.stringify(m.new ?? m.old, null, 2)}`)); while (feed.children.length > 100) feed.lastChild.remove(); }
    };
    ws.onclose = () => { if (RT === ws) status.textContent = "disconnected"; };
  };
  clear(body);
  body.append(h("div", { class: "stack" }, h("h2", null, "Realtime inspector"),
    h("p", { class: "muted" }, "Listens as service_role, so every change is shown. Apps receive only the rows their own role can read."),
    h("div", { class: "row" }, select, h("button", { class: "primary", id: "rt-start", onclick: start }, "Listen"), h("button", { onclick: stop }, "Stop"), status), feed));
}

// ---------- logs ----------
async function logs(body, p) {
  const [reqs, audit] = await Promise.all([api("GET", `/v1/projects/${p.ref}/logs`), api("GET", "/v1/audit-log?limit=100")]);
  clear(body);
  body.append(h("div", { class: "stack" },
    h("div", { class: "row between" }, h("h2", null, "API requests"), h("button", { onclick: () => logs(body, p) }, "Refresh")),
    h("div", { class: "tablewrap" }, reqs.length ? h("table", { class: "data", id: "request-log" }, h("thead", null, h("tr", null, ["Time", "Method", "Path", "Status", "Duration"].map((x) => h("th", null, x)))),
      h("tbody", null, reqs.map((r) => h("tr", null, h("td", null, new Date(r.at).toLocaleTimeString()), h("td", null, r.method), h("td", { class: "mono" }, r.path), h("td", { class: r.status >= 500 ? "bad" : r.status >= 400 ? "warn" : "ok" }, r.status), h("td", null, `${r.ms} ms`))))) : h("div", { class: "empty" }, "No requests since the server started. Recent requests are kept in memory.")),
    h("h2", null, "Activity"),
    h("div", { class: "tablewrap" }, h("table", { class: "data", id: "audit-log" }, h("thead", null, h("tr", null, ["Time", "Action", "Target", "By"].map((x) => h("th", null, x)))),
      h("tbody", null, audit.filter((a) => !a.target || a.target === p.ref).map((a) => h("tr", null, h("td", null, fmtDate(a.at)), h("td", null, a.action), h("td", { class: "mono" }, a.target || ""), h("td", { class: "mono" }, a.actor.slice(0, 8)))))))));
}

// ---------- backups ----------
async function backups(body, p) {
  const rows = await api("GET", `/v1/projects/${p.ref}/backups`);
  clear(body);
  body.append(h("div", { class: "stack" },
    h("div", { class: "row between" }, h("h2", null, "Backups"), h("button", { class: "primary", id: "create-backup", onclick: async (e) => {
      e.target.disabled = true;
      try { await api("POST", `/v1/projects/${p.ref}/backups`, {}); toast("Backup created", "ok"); } catch (ex) { toast(ex.message, "bad"); }
      backups(body, p);
    } }, "Create backup")),
    h("p", { class: "muted" }, "Logical database backups. Restoring replaces the whole database with the backup; files in Storage are not included. Point-in-time recovery is not provided."),
    h("div", { class: "tablewrap" }, rows.length ? h("table", { class: "data", id: "backup-list" }, h("thead", null, h("tr", null, ["Created", "Kind", "Status", "Size", "Note", ""].map((x) => h("th", null, x)))),
      h("tbody", null, rows.map((b) => h("tr", { "data-backup": b.id }, h("td", null, fmtDate(b.created_at)), h("td", null, b.kind), h("td", { class: b.status === "failed" ? "bad" : "" }, b.status), h("td", null, b.size_bytes ? fmtBytes(b.size_bytes) : "—"), h("td", null, b.note || b.error || ""),
        h("td", { class: "row" }, b.status === "complete" && h("button", { class: "small danger", "data-action": "restore", onclick: async () => {
          if (!(await confirmBox("Restore backup", `This replaces the current database of ${p.name} with the backup from ${fmtDate(b.created_at)}.`, { typed: p.name, confirmLabel: "Restore" }))) return;
          try { await api("POST", `/v1/projects/${p.ref}/backups/${b.id}/restore`); toast("Restored", "ok"); S.tables = null; } catch (ex) { toast(ex.message, "bad"); }
          backups(body, p);
        } }, "Restore"), h("button", { class: "small", onclick: async () => { await api("DELETE", `/v1/projects/${p.ref}/backups/${b.id}`); backups(body, p); } }, "Delete")))))) : h("div", { class: "empty" }, "No backups yet."))));
}

// ---------- settings ----------
async function settings(body, p) {
  const s = await api("GET", `/v1/projects/${p.ref}/settings`);
  const plans = await api("GET", "/v1/plans");
  const owner = S.me.role === "owner";
  const envText = Object.entries(s.function_env || {}).map(([k, v]) => `${k}=${v}`).join("\n");
  const expiry = h("input", { id: "set-expiry", type: "number", min: 60, max: 604800, value: s.jwt_expiry ?? 3600 });
  const disable = h("input", { id: "set-disable", type: "checkbox", checked: s.disable_signup === true });
  const env = h("textarea", { id: "set-env", class: "code", rows: 4, placeholder: "STRIPE_KEY=…" }, envText);
  clear(body);
  body.append(h("div", { class: "stack" },
    h("div", { class: "card stack" }, h("h3", null, "Authentication"),
      h("label", { class: "field" }, "Access token lifetime (seconds)", expiry),
      h("label", { class: "check" }, disable, "Disable new sign-ups"),
      h("h3", null, "Function environment"), env, h("p", { class: "muted" }, "One KEY=value per line. Available to functions as environment variables."),
      h("div", { class: "row" }, h("button", { class: "primary", id: "save-settings", onclick: async () => {
        try {
          const fe = {};
          for (const line of env.value.split("\n").map((x) => x.trim()).filter(Boolean)) { const i = line.indexOf("="); if (i < 1) throw new Error(`Invalid line: ${line}`); fe[line.slice(0, i)] = line.slice(i + 1); }
          await api("PATCH", `/v1/projects/${p.ref}/settings`, { jwt_expiry: Number(expiry.value), disable_signup: disable.checked, function_env: fe });
          toast("Settings saved", "ok");
        } catch (ex) { toast(ex.message, "bad"); }
      } }, "Save"))),
    h("div", { class: "card stack" }, h("h3", null, "Plan"),
      h("div", { class: "row" }, h("select", { id: "set-plan", disabled: !owner }, Object.keys(plans).map((k) => h("option", { value: k, selected: k === p.plan }, k))),
        h("button", { id: "save-plan", disabled: !owner, onclick: async () => { try { await api("PATCH", `/v1/projects/${p.ref}`, { plan: document.getElementById("set-plan").value }); toast("Plan updated", "ok"); await refreshProject(); } catch (ex) { toast(ex.message, "bad"); } } }, "Change plan"),
        !owner && h("span", { class: "muted" }, "Only owners can change the plan"))),
    h("div", { class: "card stack" }, h("h3", null, "Danger zone"),
      h("div", { class: "row" },
        p.status === "paused"
          ? h("button", { id: "resume-project", onclick: async () => { await api("POST", `/v1/projects/${p.ref}/resume`); toast("Project resumed", "ok"); S.project = null; route(); } }, "Resume project")
          : h("button", { id: "pause-project", onclick: async () => { if (await confirmBox("Pause project", "The API goes offline until you resume it.", { danger: false, confirmLabel: "Pause" })) { await api("POST", `/v1/projects/${p.ref}/pause`); toast("Project paused", "ok"); S.project = null; route(); } } }, "Pause project"),
        h("button", { class: "danger", id: "delete-project", onclick: async () => { if (await confirmBox("Delete project", "The project stops working immediately and its data is permanently removed after the retention period.", { typed: p.name, confirmLabel: "Delete project" })) { await api("DELETE", `/v1/projects/${p.ref}`); toast("Project deleted", "ok"); S.project = null; location.hash = "#/projects"; } } }, "Delete project")))));
}

// ---------- router ----------
async function route() {
  if (RT) { RT.close(); RT = null; }
  if (!S.token) {
    S.token = localStorage.getItem("baas.token") || sessionStorage.getItem("baas.token");
    if (S.token) { try { S.me = await api("GET", "/v1/me"); } catch { S.token = null; } }
  }
  if (!S.token) return renderLogin();
  if (!S.config) S.config = await fetch("/v1/config").then((r) => r.json());
  if (!S.me) S.me = await api("GET", "/v1/me");
  const m = /^#\/p\/([a-z0-9]{20})\/([a-z]+)/.exec(location.hash);
  try {
    if (m) await renderProject(m[1], m[2]);
    else { S.project = null; await renderProjects(); }
  } catch (ex) {
    mount(shell(h("div", { class: "notice bad", id: "route-error" }, ex.message), h("p", null, h("a", { href: "#/projects" }, "Back to projects"))));
  }
}

window.addEventListener("hashchange", route);
route();
