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

// ---------- icons (inline SVG; no external files, so the CSP stays strict) ----------
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  children.forEach((c) => c && el.append(c));
  return el;
}
const ICONS = {
  home: [["path", { d: "M3 11l9-8 9 8" }], ["path", { d: "M5 10v10h5v-6h4v6h5V10" }]],
  table: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["path", { d: "M3 10h18M3 15h18M10 4v16" }]],
  terminal: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["path", { d: "M7 9l3 3-3 3M13 15h4" }]],
  database: [["ellipse", { cx: 12, cy: 5, rx: 8, ry: 3 }], ["path", { d: "M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" }]],
  lock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ["path", { d: "M8 11V8a4 4 0 018 0v3" }]],
  folder: [["path", { d: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" }]],
  zap: [["path", { d: "M13 2L4 14h7l-1 8 9-12h-7z" }]],
  radio: [["circle", { cx: 12, cy: 12, r: 2 }], ["path", { d: "M16.2 7.8a6 6 0 010 8.4M7.8 16.2a6 6 0 010-8.4M19 5a10 10 0 010 14M5 19a10 10 0 010-14" }]],
  sparkles: [["path", { d: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" }], ["path", { d: "M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" }]],
  list: [["path", { d: "M8 6h13M8 12h13M8 18h13" }], ["circle", { cx: 3.5, cy: 6, r: 1 }], ["circle", { cx: 3.5, cy: 12, r: 1 }], ["circle", { cx: 3.5, cy: 18, r: 1 }]],
  settings: [["circle", { cx: 12, cy: 12, r: 3.5 }], ["path", { d: "M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" }]],
  plug: [["path", { d: "M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0zM12 18v4" }]],
  search: [["circle", { cx: 11, cy: 11, r: 7 }], ["path", { d: "M21 21l-4.5-4.5" }]],
  chevrons: [["path", { d: "M8 9l4-4 4 4M8 15l4 4 4-4" }]],
  chevron: [["path", { d: "M6 9l6 6 6-6" }]],
  cpu: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ["path", { d: "M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" }]],
  git: [["circle", { cx: 6, cy: 6, r: 2 }], ["circle", { cx: 6, cy: 18, r: 2 }], ["circle", { cx: 18, cy: 8, r: 2 }], ["path", { d: "M6 8v8M18 10c0 5-8 3-12 6" }]],
  archive: [["rect", { x: 3, y: 4, width: 18, height: 5, rx: 1 }], ["path", { d: "M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9M10 13h4" }]],
  hard: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["path", { d: "M3 12h18M7 16h.01M11 16h.01" }]],
  users: [["circle", { cx: 9, cy: 8, r: 3.5 }], ["path", { d: "M2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5M16 4.5a3.5 3.5 0 010 7M18 14.8c2 .6 3.3 2.3 3.6 5.2" }]],
  bolt: [["path", { d: "M13 3L5 13.5h6L10 21l9-11.5h-6z" }]],
};
function icon(name, size = 18) {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" });
  for (const [tag, attrs] of ICONS[name] || []) svg.append(svgEl(tag, attrs));
  return svg;
}
function ago(d) {
  if (!d) return "never";
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  const u = [[86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [n, name] of u) if (s >= n) { const v = Math.floor(s / n); return `${v} ${name}${v === 1 ? "" : "s"} ago`; }
  return "just now";
}
const pgLit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const schemaOk = (s) => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s);


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

// ---------- shell: top bar, icon rail, section sidebar ----------
const LOGO = () => svgEl("svg", { viewBox: "0 0 24 24", width: 22, height: 22, fill: "currentColor", "aria-hidden": "true" }, svgEl("path", { d: "M13.4 2L4 13.6h6.2L9.4 22 20 9.6h-6.6z" }));

function closeMenus() { document.querySelectorAll(".menu").forEach((m) => m.remove()); }
document.addEventListener("click", (e) => { if (!e.target.closest(".menu, .avatar")) closeMenus(); });

function appbar(project) {
  const initials = (S.me?.organization.name || "?").slice(0, 2).toUpperCase();
  const avatar = h("button", { class: "avatar", id: "avatar", "aria-label": "Account menu", title: "Account", onclick: (e) => {
    e.stopPropagation();
    if (document.querySelector(".menu")) return closeMenus();
    document.body.append(h("div", { class: "menu", role: "menu" },
      h("div", { class: "who", id: "who" }, h("div", null, S.me.organization.name), h("div", { class: "muted" }, `${S.me.role} · ${S.me.organization.slug}`)),
      h("button", { role: "menuitem", onclick: () => { closeMenus(); location.hash = "#/projects"; } }, "All projects"),
      h("button", { role: "menuitem", id: "signout", onclick: logout }, "Sign out")));
  } }, initials);
  const search = h("button", { class: "searchbox", id: "open-palette", title: "Search pages (Ctrl/⌘+K)", onclick: openPalette }, icon("search", 15), h("span", null, "Search…"), h("kbd", null, "⌘K"));
  return h("header", { class: "appbar" },
    h("a", { class: "logo", href: "#/projects", title: "All projects", "aria-label": "baas" }, LOGO()),
    h("span", { class: "sep org" }, "/"),
    h("a", { class: "crumb org", href: "#/projects" }, S.me?.organization.name || "", project && h("span", { class: "chip" }, project.plan), icon("chevrons", 14)),
    project && [h("span", { class: "sep" }, "/"), h("a", { class: "crumb", href: `#/p/${project.ref}/overview`, id: "crumb-project" }, project.name, icon("chevrons", 14)), h("span", { class: `chip ${project.status}`, id: "project-status" }, project.status)],
    project && h("button", { id: "connect-btn", onclick: () => connectDialog(project) }, icon("plug", 15), " Connect"),
    h("span", { class: "spacer" }),
    search, avatar);
}

/** Plain page: top bar plus a centred column (used for the project list and errors). */
function shell(...content) {
  return h("div", null, appbar(null), h("main", { class: "plain" }, content));
}
const mount = (node) => { clear($app); $app.append(node); };

async function connectDialog(p) {
  const url = gwBase(p.ref);
  await dialog("Connect to this project", () => h("div", { class: "stack" },
    h("div", { class: "kv" },
      h("span", { class: "k" }, "Project URL"), ...copyable(url),
      h("span", { class: "k" }, "anon key"), ...copyable(S.keys.anon, { secret: true }),
      h("span", { class: "k" }, "service_role key"), ...(S.keys.service_role ? copyable(S.keys.service_role, { secret: true }) : [h("span", { class: "muted" }, "Requires the admin role"), h("span")])),
    h("h3", null, "Client"),
    h("pre", null, `import { createClient } from "baas/client";\nconst baas = createClient("${url}", "<anon key>");\nawait baas.from("todos").select("*");`),
    h("h3", null, "Environment"),
    h("pre", null, `BAAS_URL=${url}\nBAAS_ANON_KEY=<anon key>`),
    h("p", { class: "muted" }, "The service_role key bypasses row-level security. Keep it on servers only.")), { confirmLabel: "Close" });
}

// ---------- command palette ----------
function pageIndex(ref) {
  const out = [["Projects", "#/projects"]];
  for (const n of NAV) if (n.id && n.id !== "database") out.push([n.label, `#/p/${ref}/${n.id}`]);
  for (const g of DB_MENU) for (const [id, label] of g.items) out.push([`Database › ${label}`, `#/p/${ref}/database/${id}`]);
  return out;
}
function openPalette() {
  const ref = S.project?.ref;
  const entries = ref ? pageIndex(ref) : [["Projects", "#/projects"]];
  const input = h("input", { placeholder: "Jump to a page…", "aria-label": "Search pages", id: "palette-input", autocomplete: "off" });
  const list = h("ul", { id: "palette-list" });
  let shown = entries, at = 0;
  const draw = () => {
    clear(list);
    shown.slice(0, 40).forEach(([label, hash], i) => list.append(h("li", null, h("button", { type: "button", class: i === at ? "on" : "", onclick: () => go(hash), "data-hash": hash }, label))));
    if (!shown.length) list.append(h("li", { class: "empty" }, "No matching pages."));
  };
  let dlg;
  const go = (hash) => { dlg.close(); location.hash = hash; };
  input.addEventListener("input", () => { const q = input.value.toLowerCase(); shown = entries.filter(([l]) => l.toLowerCase().includes(q)); at = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { at = Math.min(at + 1, Math.max(0, shown.length - 1)); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { at = Math.max(at - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && shown[at]) { e.preventDefault(); go(shown[at][1]); }
  });
  dlg = h("dialog", { class: "palette" }, input, list);
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  draw();
  dlg.showModal();
  input.focus();
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && S.token && !document.querySelector("dialog[open]")) { e.preventDefault(); openPalette(); }
});

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
const NAV = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "tables", label: "Table editor", icon: "table" },
  { id: "sql", label: "SQL editor", icon: "terminal" },
  { id: "database", label: "Database", icon: "database" },
  { divider: true },
  { id: "auth", label: "Authentication", icon: "lock" },
  { id: "storage", label: "Storage", icon: "folder" },
  { id: "functions", label: "Edge Functions", icon: "zap" },
  { id: "realtime", label: "Realtime", icon: "radio" },
  { id: "ai", label: "Ask AI", icon: "sparkles" },
  { divider: true },
  { id: "logs", label: "Logs", icon: "list" },
  { grow: true },
  { id: "settings", label: "Project settings", icon: "settings" },
];
const DB_MENU = [
  { title: "Database management", items: [["tables", "Tables"], ["functions", "Functions"], ["triggers", "Triggers"], ["enums", "Enumerated Types"], ["extensions", "Extensions"], ["indexes", "Indexes"]] },
  { title: "Access control", items: [["policies", "Policies"], ["roles", "Roles"]] },
  { title: "Platform", items: [["backups", "Backups"], ["migrations", "Migrations"]] },
];
const OLD_TABS = { backups: "database/backups" };

async function renderProject(ref, tab, page) {
  if (OLD_TABS[tab]) { location.replace(`#/p/${ref}/${OLD_TABS[tab]}`); return; }
  if (!S.project || S.project.ref !== ref) {
    S.project = await api("GET", `/v1/projects/${ref}`);
    S.keys = await api("GET", `/v1/projects/${ref}/api-keys`);
    S.tables = null;
  }
  const p = S.project;
  if (!NAV.some((n) => n.id === tab)) tab = "overview";
  if (tab === "database" && !DB_MENU.some((g) => g.items.some(([id]) => id === page))) page = "tables";
  const body = h("div", { id: "tab-body", "data-page": tab === "database" ? `database/${page}` : tab }, h("p", { class: "muted" }, "Loading…"));
  const rail = h("nav", { class: "rail", "aria-label": "Project sections" }, NAV.map((n) =>
    n.divider ? h("div", { class: "divider" }) : n.grow ? h("div", { class: "grow" })
      : h("a", { href: `#/p/${ref}/${n.id === "database" ? "database/tables" : n.id}`, class: n.id === tab ? "on" : "", "data-tab": n.id, title: n.label, "aria-label": n.label }, icon(n.icon, 19))));
  const sub = tab === "database" ? h("nav", { class: "sub", "aria-label": "Database" }, h("div", { class: "title" }, "Database"),
    DB_MENU.map((g) => [h("div", { class: "group label" }, g.title), g.items.map(([id, label]) => h("a", { href: `#/p/${ref}/database/${id}`, class: id === page ? "on" : "", "data-dbpage": id }, label))])) : null;
  mount(h("div", null, appbar(p),
    h("div", { class: `frame ${sub ? "with-sub" : ""}` }, rail, sub,
      h("main", { class: "content" },
        p.status === "paused" && h("div", { class: "notice warn", id: "paused-note" }, "This project is paused: its API is offline. Resume it in Project settings."),
        body))));
  const fn = { overview, tables, sql, ai, auth, storage, functions, realtime, logs, settings }[tab];
  try {
    if (tab === "database") await dbPage(body, p, page);
    else await fn(body, p);
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
  if (secret) controls.push(h("button", { class: "small", type: "button", onclick: (e) => { shown = !shown; code.textContent = shown ? value : "•".repeat(24); e.target.textContent = shown ? "Hide" : "Reveal"; } }, "Reveal"));
  controls.push(h("button", { class: "small", type: "button", onclick: async () => { await navigator.clipboard?.writeText(value).catch(() => {}); toast("Copied"); } }, "Copy"));
  return [code, h("span", { class: "row" }, controls)];
}

function meter(label, used, limit) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const fill = h("i");
  fill.style.width = `${pct}%`;
  return h("div", { class: "meter" }, h("div", { class: "row between" }, h("span", null, label), h("span", { class: "muted" }, `${used.toLocaleString()} / ${limit.toLocaleString()}`)), h("div", { class: `bar ${pct > 90 ? "hot" : ""}` }, fill));
}


const SERVICE_LABELS = { rest: "REST API", auth: "Auth", storage: "Storage", functions: "Edge Functions", realtime: "Realtime" };

/** A bar chart as inline SVG. Bars turn amber when a bucket had client errors and red when it had server errors. */
function barChart(requests, warnings, errors) {
  const n = requests.length;
  const W = 240, H = 92, gap = n > 60 ? 0.5 : 1.5;
  const bw = W / n - gap;
  const max = Math.max(1, ...requests);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": `${requests.reduce((a, b) => a + b, 0)} requests` });
  requests.forEach((v, i) => {
    const hgt = v ? Math.max(3, (v / max) * (H - 4)) : 2;
    svg.append(svgEl("rect", { x: i * (bw + gap), y: H - hgt, width: Math.max(bw, 0.6), height: hgt, rx: 1, class: !v ? "empty" : errors[i] ? "err" : warnings[i] ? "warn" : "ok" }));
  });
  return svg;
}

/** Sum consecutive hours into fewer buckets so a week of data stays readable. */
function rebucket(m, size) {
  if (size <= 1) return m;
  const fold = (a) => Array.from({ length: Math.ceil(a.length / size) }, (_, i) => a.slice(i * size, (i + 1) * size).reduce((x, y) => x + y, 0));
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { requests: fold(v.requests), warnings: fold(v.warnings), errors: fold(v.errors) }]));
}

function metricsView(data, hours) {
  const services = rebucket(data.services, hours > 48 ? 3 : 1);
  return h("div", { class: "metric-grid", id: "metric-grid" }, Object.entries(SERVICE_LABELS).map(([key, label]) => {
    const m = services[key];
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    return h("div", { class: "metric", "data-service": key },
      h("div", { class: "head" },
        h("div", null, h("div", { class: "label" }, label), h("div", { class: "total" }, sum(m.requests).toLocaleString())),
        h("div", { class: "counts" }, h("span", null, "Warnings"), h("b", null, sum(m.warnings).toLocaleString()), h("span", null, "Errors"), h("b", null, sum(m.errors).toLocaleString()))),
      barChart(m.requests, m.warnings, m.errors));
  }));
}

async function overview(body, p) {
  const url = gwBase(p.ref);
  const canSql = S.me.role !== "developer";
  const [usage, metrics, backupsList, facts] = await Promise.all([
    api("GET", `/v1/projects/${p.ref}/usage`),
    api("GET", `/v1/projects/${p.ref}/metrics?hours=24`),
    api("GET", `/v1/projects/${p.ref}/backups`).catch(() => []),
    canSql ? sqlRun(`select current_setting('server_version') as version,
        (select count(*) from pg_stat_activity where datname = current_database())::int as conns,
        (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname = 'public')::int as tables,
        (select name from baas_internal.migrations order by applied_at desc limit 1) as migration`).catch(() =>
      sqlRun(`select current_setting('server_version') as version, (select count(*) from pg_stat_activity where datname = current_database())::int as conns,
        (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname = 'public')::int as tables, null::text as migration`)).catch(() => null) : null,
  ]);
  const f = facts ? Object.fromEntries(facts[0].fields.map((k, i) => [k, facts[0].rows[0][i]])) : null;
  const lastBackup = backupsList.find((b) => b.status === "complete");
  const stat = (ico, label, val, extra) => h("div", { class: "stat", "data-stat": label.toLowerCase() }, h("div", { class: "ico" }, icon(ico, 20)), h("div", null, h("div", { class: "label" }, label), h("div", { class: "val" }, val), extra));
  const healthy = p.status === "active";
  const range = h("select", { id: "metric-range", "aria-label": "Time range" }, h("option", { value: 24 }, "Last 24 hours"), h("option", { value: 168 }, "Last 7 days"));
  const totals = h("div", { class: "metrics-head" });
  const gridSlot = h("div", { id: "metric-slot" });
  const drawMetrics = (m, hours) => {
    clear(totals);
    totals.append(
      h("div", { class: "num", id: "total-requests" }, m.totals.requests.toLocaleString(), h("span", null, "Total Requests")),
      h("div", { class: "num", id: "success-rate" }, m.totals.successRate === null ? "—" : `${m.totals.successRate.toFixed(1)}%`, h("span", null, "Success Rate")),
      h("span", { class: "spacer" }), range);
    clear(gridSlot);
    gridSlot.append(metricsView(m, hours));
  };
  range.addEventListener("change", async () => { const hrs = Number(range.value); drawMetrics(await api("GET", `/v1/projects/${p.ref}/metrics?hours=${hrs}`), hrs); });
  clear(body);
  body.append(h("div", null,
    h("div", { class: "hero" }, h("h1", { id: "project-title" }, p.name),
      h("div", { class: "urlrow" }, h("code", { class: "mono", id: "project-url" }, url), h("button", { class: "small", onclick: async () => { await navigator.clipboard?.writeText(url).catch(() => {}); toast("Copied"); } }, "Copy"))),
    h("div", { class: "overview-top" },
      h("div", { class: "stat-grid", id: "stat-grid" },
        stat("hard", "Status", h("span", null, h("span", { class: "dots" }, h("i"), h("i"), h("i")), healthy ? "Healthy" : p.status)),
        stat("cpu", "Requests today", `${Number(usage.daily[0]?.requests || 0).toLocaleString()} of ${usage.limits.requestsPerDay.toLocaleString()}`),
        stat("database", "Database", `${fmtBytes(usage.current?.db_bytes || 0)} of ${fmtBytes(usage.limits.dbBytes)}`),
        stat("folder", "Storage", `${fmtBytes(usage.current?.storage_bytes || 0)} of ${fmtBytes(usage.limits.storageBytes)}`),
        stat("git", "Last migration", f?.migration || "None", !f?.migration && canSql ? h("div", { class: "muted" }, "baas db push") : null),
        stat("archive", "Last backup", lastBackup ? ago(lastBackup.created_at) : "Never")),
      h("div", { class: "arch", id: "arch" }, h("div", { class: "node" },
        h("div", { class: "top" }, h("div", { class: "ico" }, icon("database", 18)), h("div", null, h("div", null, h("strong", null, "Primary Database")), h("div", { class: "muted" }, f ? `PostgreSQL ${f.version}` : "PostgreSQL"), h("div", { class: "muted mono" }, p.ref))),
        h("div", { class: "foot" }, (f ? [`${f.tables} tables`, `${f.conns} conns`, fmtBytes(usage.current?.db_bytes || 0)] : [fmtBytes(usage.current?.db_bytes || 0)]).map((x) => h("span", null, x)))))),
    usage.over_db_quota && h("div", { class: "notice bad" }, "The database is over its size limit: writes through the API are blocked until you delete data or upgrade."),
    totals, gridSlot));
  drawMetrics(metrics, 24);
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
  const prefill = sessionStorage.getItem("baas.sql.prefill");
  sessionStorage.removeItem("baas.sql.prefill");
  const editor = h("textarea", { class: "code editor", id: "sql-input", spellcheck: "false", placeholder: "select now();" }, prefill ?? (hist[0] || ""));
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
let AI = { ref: null, entries: [], as: null };

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
    box.append(h("div", { class: "muted small-note", "data-answered-as": "1" }, `Answered as ${r.answeredAs.label}`));
    box.append(h("div", { class: "bubble ai", "data-answer": "1" }, r.answer));
    if (r.steps.length) box.append(h("div", { class: "steps" }, r.steps.filter((s) => s.tool === "run_query").length ? h("p", { class: "muted" }, "Queries the assistant ran (read-only):") : null, r.steps.filter((s) => s.tool === "run_query").map(stepView)));
    r.proposals.forEach((pr) => box.append(proposalCard(pr, e)));
  }
  return box;
}

async function ai(body, p) {
  if (AI.ref !== p.ref) AI = { ref: p.ref, entries: [], as: null };
  const st = await api("GET", `/v1/projects/${p.ref}/ai`);
  // Default identity follows the project's setting; "everyone" is only ever selectable while the owner allows it.
  if (!AI.as || (AI.as.type === "service" && !st.allowBypassRls)) AI.as = { type: st.defaultIdentity };
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
      h("p", null, "By default it sees your data the way an anonymous visitor would, with row-level security applied. You can ask as a specific user to check what they can see. Only a project owner can let it ignore row-level security."),
      h("div", { class: "notice warn", id: "ai-notice" }, st.notice),
      h("p", { class: "muted" }, "It can read only what the chosen identity may read through the API: tables your policies and grants expose to it, never users, sessions or other internals."),
      h("button", { class: "primary", id: "ai-enable", disabled: !canAdmin, title: canAdmin ? "" : "Requires the admin role", onclick: async () => {
        if (!(await confirmBox("Enable the AI assistant?", st.notice, { danger: false, confirmLabel: "Enable" }))) return;
        try { await api("POST", `/v1/projects/${p.ref}/ai/enable`); toast("AI assistant enabled", "ok"); ai(body, p); } catch (ex) { toast(ex.message, "bad"); }
      } }, "Enable for this project")));
    return;
  }
  const list = h("div", { class: "chat", id: "ai-chat" });
  const identityBar = h("div", { class: "row", id: "ai-identity" });
  const drawIdentity = () => {
    clear(identityBar);
    const sel = h("select", { id: "ai-as", "aria-label": "Ask as" },
      h("option", { value: "anon", selected: AI.as.type === "anon" }, "an anonymous visitor (public data only)"),
      h("option", { value: "user", selected: AI.as.type === "user" }, "a specific user…"),
      st.allowBypassRls && h("option", { value: "service", selected: AI.as.type === "service" }, "everyone — ignore row-level security"));
    sel.addEventListener("change", () => { AI.as = sel.value === "user" ? { type: "user", userId: null, email: null } : { type: sel.value }; drawIdentity(); });
    identityBar.append(h("span", { class: "muted" }, "Ask as"), sel);
    if (AI.as.type === "user") {
      if (AI.as.userId) identityBar.append(h("span", { class: "badge", id: "ai-user-chip" }, AI.as.email), h("button", { class: "small", onclick: () => { AI.as = { type: "user", userId: null, email: null }; drawIdentity(); } }, "Change"));
      else {
        const q = h("input", { id: "ai-user-q", placeholder: "search users by email", "aria-label": "Search users" });
        const found = h("div", { class: "row", id: "ai-user-results" });
        const search = async () => {
          try {
            const users = await api("GET", `/v1/projects/${p.ref}/ai/users?q=${encodeURIComponent(q.value)}`);
            clear(found);
            if (!users.length) found.append(h("span", { class: "muted" }, "No users match."));
            users.forEach((u) => found.append(h("button", { class: "small", "data-user": u.email, onclick: () => { AI.as = { type: "user", userId: u.id, email: u.email }; drawIdentity(); } }, u.email)));
          } catch (ex) { toast(ex.message, "bad"); }
        };
        q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
        identityBar.append(q, h("button", { id: "ai-user-search", onclick: search }, "Search"), found);
      }
    }
  };
  const isOwner = S.me.role === "owner";
  const allow = h("input", { type: "checkbox", id: "ai-allow-bypass", checked: st.allowBypassRls, disabled: (st.allowBypassRls ? !canAdmin : !isOwner) });
  allow.addEventListener("change", async () => {
    const want = allow.checked;
    if (want && !(await confirmBox("Let the assistant ignore row-level security?", "In “everyone” mode the assistant can read every row in your public tables, including rows your policies hide from users, and those rows can be sent to Anthropic. Only turn this on if that is acceptable for this project's data.", { danger: true, confirmLabel: "Allow" }))) { allow.checked = false; return; }
    try { await api("PUT", `/v1/projects/${p.ref}/ai/config`, { allowBypassRls: want }); toast(want ? "Everyone mode allowed" : "Everyone mode turned off", "ok"); ai(body, p); } catch (ex) { allow.checked = !want; toast(ex.message, "bad"); }
  });
  const settings = h("details", { id: "ai-settings" }, h("summary", null, "Assistant settings"),
    h("div", { class: "stack" },
      h("label", { class: "check" }, allow, "Allow “everyone” mode: the assistant may read all rows, ignoring row-level security"),
      h("p", { class: "muted" }, st.allowBypassRls ? "On: anyone with the admin role can ask the assistant to look at every row." : "Off: the assistant sees only what an anonymous visitor or a chosen user could see through the API."),
      !isOwner && !st.allowBypassRls && h("p", { class: "muted" }, "Only a project owner can turn this on.")));
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
      if (AI.as.type === "user" && !AI.as.userId) throw new Error("Choose which user to ask as.");
      entry.result = await api("POST", `/v1/projects/${p.ref}/ai/ask`, { question: q, history, as: AI.as.type === "user" ? { type: "user", userId: AI.as.userId } : { type: AI.as.type } });
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
    identityBar, list,
    h("div", { class: "stack" }, input, h("div", { class: "row between" }, h("span", { class: "muted" }, "Your question, the table structure and query results are sent to Anthropic. Ctrl/⌘+Enter to send."), send)),
    settings));
  drawIdentity();
  draw();
}

// ---------- database section ----------
/** Run a catalog query and return rows as objects. Identifiers going into the SQL are validated first. */
async function catalog(query) {
  const [r] = await sqlRun(query);
  return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f, row[i]])));
}
function openInSql(text) { sessionStorage.setItem("baas.sql.prefill", text); location.hash = `#/p/${S.project.ref}/sql`; }
const ROLE_NOTES = {
  anon: "Requests with only the anon key", authenticated: "Requests carrying a signed-in user's token", service_role: "The service key; bypasses row-level security",
  baas_ai_reader: "Ask AI in “everyone” mode; can read public tables, ignoring row-level security",
};

/** A searchable list page. `cfg.query(schema)` returns SQL; `cfg.cols` describe the columns; `cfg.actions(row, reload)` returns buttons. */
async function listPage(body, p, cfg) {
  const state = { schema: "public", q: "" };
  let schemas = ["public"];
  if (cfg.schemas !== false) schemas = (await catalog(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by (nspname = 'public') desc, nspname`)).map((r) => r.nspname);
  const holder = h("div", { class: "tablewrap", id: "catalog-table" });
  const note = h("p", { class: "muted pagehint" }, cfg.hint || "");
  let rows = [];
  const cellFor = (c, r) => {
    const v = c.cell ? c.cell(r) : r[c.key];
    const missing = v === null || v === undefined;
    const text = missing ? "—" : v instanceof Node ? v : truncate(String(v), c.max || 80);
    return h("td", { class: `${c.mono ? "mono-cell" : ""} ${missing ? "null" : ""}`, title: typeof v === "string" ? v.slice(0, 300) : "" }, text);
  };
  const draw = () => {
    clear(holder);
    const q = state.q.toLowerCase();
    const shown = rows.filter((r) => !q || Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q)));
    if (!shown.length) { holder.append(h("div", { class: "empty" }, rows.length ? "No matches." : cfg.empty)); return; }
    const head = h("tr", null, cfg.cols.map((c) => h("th", null, c.label)), cfg.actions ? h("th") : null);
    const bodyRows = shown.map((r) => {
      const tr = h("tr", { "data-row": r.name ?? "" }, cfg.cols.map((c) => cellFor(c, r)));
      if (cfg.actions) tr.append(h("td", null, h("div", { class: "row" }, cfg.actions(r, load))));
      return tr;
    });
    holder.append(h("table", { class: "data" }, h("thead", null, head), h("tbody", null, bodyRows)));
  };
  const load = async () => {
    try { rows = await catalog(cfg.query(state.schema, p)); draw(); }
    catch (ex) { clear(holder); holder.append(h("div", { class: "empty" }, cfg.emptyOnError ? cfg.emptyOnError : ex.message)); }
  };
  const search = h("input", { id: "catalog-search", placeholder: cfg.searchPlaceholder || "Search", "aria-label": "Search", oninput: (e) => { state.q = e.target.value; draw(); } });
  const schemaSel = cfg.schemas === false ? null : h("select", { id: "catalog-schema", "aria-label": "Schema", onchange: (e) => { state.schema = e.target.value; load(); } }, schemas.map((s) => h("option", { value: s }, `schema ${s}`)));
  clear(body);
  body.append(h("div", null,
    h("div", { class: "page-head" }, h("h1", null, cfg.title), cfg.headAction ? cfg.headAction(load) : null),
    cfg.hint && note,
    h("div", { class: "toolbar" }, schemaSel, search),
    holder));
  await load();
}

const definitionDialog = (title, sqlText, extra) => dialog(title, () => h("div", { class: "stack" }, h("pre", { class: "sql" }, sqlText), extra), { confirmLabel: "Close" });

const DB_PAGES = {
  tables: {
    title: "Tables", hint: "Tables, views and other relations in the schema. Use the Table editor to browse and edit rows.", searchPlaceholder: "Search for a table", empty: "No tables in this schema.",
    query: (s) => `select c.relname as name, case c.relkind when 'r' then 'table' when 'p' then 'partitioned table' when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' end as kind,
      (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::int as columns, c.relrowsecurity as rls, greatest(c.reltuples, 0)::bigint as rows_estimate,
      pg_size_pretty(pg_total_relation_size(c.oid)) as size, obj_description(c.oid) as comment
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${pgLit(s)} and c.relkind in ('r','p','v','m','f') order by c.relname`,
    cols: [{ key: "name", label: "Name" }, { key: "kind", label: "Type" }, { key: "columns", label: "Columns" }, { label: "RLS", cell: (r) => (r.rls ? "on" : h("span", { class: "warn" }, "off")) }, { key: "rows_estimate", label: "Rows (est.)" }, { key: "size", label: "Size" }, { key: "comment", label: "Comment", max: 60 }],
    actions: (r) => [
      h("button", { class: "small", onclick: async () => {
        const schema = document.getElementById("catalog-schema")?.value || "public";
        const cols = await catalog(`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as default
          from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = ${pgLit(`${schema}.${r.name}`)}::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`);
        await dialog(`${schema}.${r.name}`, () => h("div", { class: "tablewrap" }, h("table", { class: "data" }, h("thead", null, h("tr", null, ["Column", "Type", "Nullable", "Default"].map((x) => h("th", null, x)))),
          h("tbody", null, cols.map((c) => h("tr", null, h("td", null, c.name), h("td", { class: "mono-cell" }, c.type), h("td", null, c.nullable ? "yes" : "no"), h("td", { class: "mono-cell" }, c.default ?? "—")))))), { confirmLabel: "Close" });
      } }, "Columns"),
    ],
  },
  triggers: {
    title: "Triggers", hint: "Functions that run automatically when rows change.", searchPlaceholder: "Search for a trigger", empty: "No triggers in this schema.",
    query: (s) => `select t.tgname as name, c.relname as "table", p.proname as function, pg_get_triggerdef(t.oid) as definition, t.tgenabled <> 'D' as enabled
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and n.nspname = ${pgLit(s)} order by c.relname, t.tgname`,
    cols: [{ key: "name", label: "Name" }, { key: "table", label: "Table" }, { key: "function", label: "Function" },
      { label: "Events", cell: (r) => (/(?:BEFORE|AFTER|INSTEAD OF) ([A-Z ]+?) ON /.exec(r.definition)?.[1] || "").replace(/ OR /g, ", ") }, { label: "Enabled", cell: (r) => (r.enabled ? "yes" : "no") }],
    actions: (r) => [h("button", { class: "small", onclick: () => definitionDialog(`Trigger ${r.name}`, r.definition) }, "Definition")],
  },
  enums: {
    title: "Enumerated Types", hint: "Custom types with a fixed list of values.", searchPlaceholder: "Search for a type", empty: "No enumerated types in this schema.",
    query: (s) => `select t.typname as name, (select string_agg(e.enumlabel, ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as "values"
      from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype = 'e' and n.nspname = ${pgLit(s)} order by t.typname`,
    cols: [{ key: "name", label: "Name" }, { key: "values", label: "Values", max: 120 }],
  },
  extensions: {
    schemas: false, title: "Extensions", hint: "PostgreSQL extensions installed in this database. Installing more is done by whoever runs the server.", searchPlaceholder: "Search for an extension", empty: "No extensions.",
    query: () => `select e.name, e.default_version as version, e.installed_version, e.comment from pg_available_extensions e order by (e.installed_version is null), e.name`,
    cols: [{ key: "name", label: "Name" }, { label: "Status", cell: (r) => (r.installed_version ? h("span", { class: "ok" }, `enabled ${r.installed_version}`) : h("span", { class: "muted" }, "available")) }, { key: "comment", label: "Description", max: 90 }],
  },
  indexes: {
    title: "Indexes", hint: "Indexes speed up lookups. Create one in the SQL editor.", searchPlaceholder: "Search for an index", empty: "No indexes in this schema.",
    query: (s) => `select i.indexname as name, i.tablename as "table", i.indexdef as definition, pg_size_pretty(pg_relation_size((quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass)) as size
      from pg_indexes i where i.schemaname = ${pgLit(s)} order by i.tablename, i.indexname`,
    cols: [{ key: "name", label: "Name" }, { key: "table", label: "Table" }, { key: "definition", label: "Definition", mono: true, max: 90 }, { key: "size", label: "Size" }],
    actions: (r) => [h("button", { class: "small", onclick: () => definitionDialog(`Index ${r.name}`, r.definition) }, "Definition")],
  },
  policies: {
    title: "Policies", hint: "Row-level security policies decide which rows each role can read or change. Tables with security on and no policy hide every row.", searchPlaceholder: "Search for a policy", empty: "No policies in this schema.",
    headAction: () => h("button", { class: "primary", id: "new-policy", onclick: () => openInSql("create policy \"policy name\" on public.your_table\n  for select to authenticated\n  using ( auth.uid() = user_id );") }, "New policy"),
    query: (s) => `select p.policyname as name, p.tablename as "table", p.cmd as command, array_to_string(p.roles, ', ') as roles, p.permissive, p.qual as "using", p.with_check as "check"
      from pg_policies p where p.schemaname = ${pgLit(s)} order by p.tablename, p.policyname`,
    cols: [{ key: "name", label: "Name" }, { key: "table", label: "Table" }, { key: "command", label: "Command" }, { key: "roles", label: "Roles" }, { key: "using", label: "Using", mono: true, max: 60 }, { key: "check", label: "With check", mono: true, max: 60 }],
    actions: (r, reload) => [
      h("button", { class: "small", onclick: () => definitionDialog(`Policy ${r.name}`, `create policy ${JSON.stringify(r.name)} on ${JSON.stringify(document.getElementById("catalog-schema").value)}.${JSON.stringify(r.table)}\n  as ${r.permissive.toLowerCase()} for ${r.command.toLowerCase()} to ${r.roles}${r.using ? `\n  using (${r.using})` : ""}${r.check ? `\n  with check (${r.check})` : ""};`) }, "Definition"),
      h("button", { class: "small danger", "data-action": "drop-policy", onclick: async () => {
        if (!(await confirmBox("Delete policy", `Delete “${r.name}” on ${r.table}? Access changes immediately.`, { confirmLabel: "Delete" }))) return;
        try { await sqlRun(`drop policy ${JSON.stringify(r.name)} on ${JSON.stringify(document.getElementById("catalog-schema").value)}.${JSON.stringify(r.table)}`); toast("Policy deleted", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); }
      } }, "Delete"),
    ],
  },
  roles: {
    schemas: false, title: "Roles", hint: "The database roles your API uses. Their privileges are granted per table; row-level security narrows them further.", searchPlaceholder: "Search for a role", empty: "No roles.",
    query: (_s, p) => `select r.rolname as name, r.rolcanlogin as can_login, r.rolbypassrls as bypass_rls, r.rolconnlimit as connection_limit from pg_roles r
      where r.rolname in ('anon', 'authenticated', 'service_role', 'baas_ai_reader') or r.rolname = ${pgLit(`authenticator_${p.ref}`)} order by r.rolname`,
    cols: [{ key: "name", label: "Name" }, { label: "Used for", cell: (r) => ROLE_NOTES[r.name] || (r.name.startsWith("authenticator_") ? "This project's login role; switches to the roles above per request" : ""), max: 90 },
      { label: "Can log in", cell: (r) => (r.can_login ? "yes" : "no") }, { label: "Bypasses RLS", cell: (r) => (r.bypass_rls ? h("span", { class: "warn" }, "yes") : "no") }, { label: "Connection limit", cell: (r) => (r.connection_limit < 0 ? "unlimited" : r.connection_limit) }],
  },
  migrations: {
    schemas: false, title: "Migrations", hint: "Migrations applied with “baas db push”. Each ran in one transaction and its checksum is kept, so edits to applied files are refused.", searchPlaceholder: "Search migrations", empty: "No migrations applied yet. Put .sql files in baas/migrations and run “baas db push”.",
    emptyOnError: "No migrations applied yet. Put .sql files in baas/migrations and run “baas db push”.",
    query: () => `select name, applied_at, left(sha256, 12) as checksum from baas_internal.migrations order by name`,
    cols: [{ key: "name", label: "Name" }, { label: "Applied", cell: (r) => fmtDate(r.applied_at) }, { key: "checksum", label: "Checksum", mono: true }],
  },
  functions: {
    title: "Database Functions", hint: "Functions stored in the database (not Edge Functions). Call them from the API with rpc, or from policies and triggers.", searchPlaceholder: "Search for a function", empty: "No functions in this schema yet.",
    headAction: (reload) => h("button", { class: "primary", id: "new-function", onclick: () => functionDialog(null, reload) }, "Create a new function"),
    query: (s) => `select p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments, pg_get_function_result(p.oid) as return_type, l.lanname as language,
      p.prosecdef as security_definer, pg_get_functiondef(p.oid) as definition, n.nspname as schema
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
      where n.nspname = ${pgLit(s)} and p.prokind = 'f' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by p.proname, p.oid`,
    cols: [{ key: "name", label: "Name" }, { key: "arguments", label: "Arguments", mono: true, max: 50 }, { key: "return_type", label: "Return type", mono: true, max: 40 }, { key: "language", label: "Language" },
      { label: "Security", cell: (r) => (r.security_definer ? h("span", { class: "warn", title: "Runs with its owner's privileges" }, "Definer") : "Invoker") }],
    actions: (r, reload) => [
      h("button", { class: "small", "data-action": "edit-function", onclick: () => functionDialog(r, reload) }, "Edit"),
      h("button", { class: "small danger", "data-action": "drop-function", onclick: async () => {
        if (!(await confirmBox("Delete function", `Delete ${r.schema}.${r.name}(${r.arguments})? Anything that calls it will fail.`, { typed: r.name, confirmLabel: "Delete function" }))) return;
        try { await sqlRun(`drop function ${JSON.stringify(r.schema)}.${JSON.stringify(r.name)}(${r.arguments})`); toast("Function deleted", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); }
      } }, "Delete"),
    ],
  },
};

const FUNCTION_TEMPLATE = `create or replace function public.hello_world()
returns text
language sql
as $$
  select 'Hello world';
$$;`;

/** Create or edit a database function by editing its SQL, so nothing about it is hidden behind a form. */
async function functionDialog(fn, reload) {
  const area = h("textarea", { class: "code editor", id: "function-sql", rows: 14, spellcheck: "false" }, fn ? fn.definition : FUNCTION_TEMPLATE);
  const ok = await dialog(fn ? `Edit ${fn.name}` : "Create a new function", () => h("div", { class: "stack" },
    h("p", { class: "muted" }, fn ? "Change the definition and save. It is applied with create or replace." : "Write the function as SQL. Functions run as the caller (security invoker) unless you say security definer."), area,
    h("p", { class: "muted" }, "To call it from the API, grant execute to the roles that need it, for example: grant execute on function public.hello_world() to anon;")), {
    confirmLabel: fn ? "Save function" : "Create function",
    onSubmit: async () => { await sqlRun(area.value); return true; },
  });
  if (ok) { toast(fn ? "Function saved" : "Function created", "ok"); reload(); }
}

async function dbPage(body, p, page) {
  if (page === "backups") { await backups(body, p); return; }
  await listPage(body, p, DB_PAGES[page]);
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
  const m = /^#\/p\/([a-z0-9]{20})\/([a-z]+)(?:\/([a-z]+))?/.exec(location.hash);
  try {
    if (m) await renderProject(m[1], m[2], m[3]);
    else { S.project = null; await renderProjects(); }
  } catch (ex) {
    mount(shell(h("div", { class: "notice bad", id: "route-error" }, ex.message), h("p", null, h("a", { href: "#/projects" }, "Back to projects"))));
  }
}

window.addEventListener("hashchange", route);
route();
