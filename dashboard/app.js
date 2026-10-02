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
  help: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M9.5 9.5a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01" }]],
  bulb: [["path", { d: "M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.5.4.8 1 .8 1.6V16h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0012 3z" }]],
  chart: [["path", { d: "M4 20V10M10 20V4M16 20v-8M22 20H2" }]],
  panel: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["path", { d: "M9 4v16" }]],
  diamond: [["path", { d: "M12 3l9 9-9 9-9-9z" }], ["circle", { cx: 12, cy: 12, r: 2.5 }]],
  grid: [["rect", { x: 4, y: 4, width: 7, height: 7, rx: 1 }], ["rect", { x: 13, y: 4, width: 7, height: 7, rx: 1 }], ["rect", { x: 4, y: 13, width: 7, height: 7, rx: 1 }], ["rect", { x: 13, y: 13, width: 7, height: 7, rx: 1 }]],
  send: [["path", { d: "M4 12l16-8-6 16-3-7z" }]],
  copy: [["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ["path", { d: "M5 15V6a2 2 0 012-2h9" }]],
  key: [["circle", { cx: 8, cy: 15, r: 4 }], ["path", { d: "M11 12l9-9M16 7l3 3" }]],
  book: [["path", { d: "M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z" }], ["path", { d: "M4 19V5M9 3v16" }]],
  dots: [["circle", { cx: 12, cy: 5, r: 1 }], ["circle", { cx: 12, cy: 12, r: 1 }], ["circle", { cx: 12, cy: 19, r: 1 }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  x: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
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


const TOAST_MAX = 3;
/** A short message in the corner. The same message shown again counts up instead of stacking; at most three show at once; click to dismiss. */
function toast(msg, kind = "") {
  const box = document.getElementById("toasts");
  const life = kind === "bad" ? 7000 : 3500;
  const same = [...box.children].find((x) => x.dataset.msg === msg && x.dataset.kind === kind);
  if (same) {
    same._n = (same._n || 1) + 1;
    same.querySelector(".n").textContent = ` ×${same._n}`;
    clearTimeout(same._t);
    same._t = setTimeout(() => same.remove(), life);
    return;
  }
  const t = h("div", { class: `toast ${kind}`, role: "status", title: "Click to dismiss", "data-msg": msg, "data-kind": kind, onclick: () => { clearTimeout(t._t); t.remove(); } }, h("span", null, msg), h("span", { class: "n" }));
  t._t = setTimeout(() => t.remove(), life);
  box.append(t);
  while (box.children.length > TOAST_MAX) { const old = box.firstElementChild; clearTimeout(old._t); old.remove(); }
}

function dialog(title, build, { confirmLabel = "OK", danger = false, onSubmit, sheet = false } = {}) {
  return new Promise((resolve) => {
    const err = h("div", { class: "notice bad", hidden: true });
    const head = sheet
      ? h("div", { class: "sheet-head" }, h("h2", null, title), h("button", { type: "button", class: "iconbtn", "aria-label": "Close", onclick: () => dlg.close() }, icon("x", 18)))
      : h("h2", null, title);
    const form = h("form", { method: "dialog" }, head, sheet ? h("div", { class: "sheet-body" }, build(), err) : [build(), err]);
    const ok = h("button", { class: danger ? "danger" : "primary", type: "submit" }, confirmLabel);
    const cancel = h("button", { type: "button", onclick: () => dlg.close() }, "Cancel");
    form.append(h("div", { class: "actions" }, cancel, ok));
    const dlg = h("dialog", { class: sheet ? "sheet" : "" }, form);
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

/** Move to a page and render it once: changing the hash already triggers a render, so only render by hand when the hash stays the same. */
function go(hash) {
  if (location.hash === hash || (hash === "" && !location.hash)) route();
  else location.hash = hash;
}

function logout() {
  if (S.token && S.me?.member) fetch("/v1/auth/logout", { method: "POST", headers: { authorization: `Bearer ${S.token}` } }).catch(() => {});
  localStorage.removeItem("baas.token");
  sessionStorage.removeItem("baas.token");
  S.token = S.me = S.project = S.keys = null;
  go("");
}

// ---------- shell: top bar, icon rail, section sidebar ----------
const LOGO = () => svgEl("svg", { viewBox: "0 0 24 24", width: 22, height: 22, fill: "currentColor", "aria-hidden": "true" }, svgEl("path", { d: "M13.4 2L4 13.6h6.2L9.4 22 20 9.6h-6.6z" }));

/** A "⋮" button that opens a small menu of actions next to it. `items` is [[label, handler, { danger, action }]]. */
function rowMenu(items) {
  return h("button", { class: "iconbtn", "aria-label": "Row actions", title: "Actions", onclick: (e) => {
    e.stopPropagation();
    const open = document.querySelector(".menu.row-menu");
    closeMenus();
    if (open && open.dataset.owner === e.currentTarget.dataset.id) return;
    const box = e.currentTarget.getBoundingClientRect();
    const menu = h("div", { class: "menu row-menu", role: "menu" }, items.map(([label, run, o = {}]) =>
      h("button", { role: "menuitem", class: o.danger ? "danger-item" : "", "data-action": o.action || "", disabled: !!o.disabled, title: o.why || "", onclick: () => { closeMenus(); run(); } }, label)));
    menu.style.position = "fixed";
    menu.style.top = `${Math.round(box.bottom + 4)}px`;
    menu.style.right = `${Math.round(window.innerWidth - box.right)}px`;
    document.body.append(menu);
  } }, icon("dots", 16));
}
function closeMenus() { document.querySelectorAll(".menu").forEach((m) => m.remove()); }
document.addEventListener("click", (e) => { if (!e.target.closest(".menu, .avatar")) closeMenus(); });
/** Open a menu under the clicked element; clicking again closes it. `nodes` are the menu's children. */
function showMenu(e, nodes, { left = false } = {}) {
  e.stopPropagation();
  const open = document.querySelector(".menu");
  closeMenus();
  if (open) return;
  const box = e.currentTarget.getBoundingClientRect();
  const menu = h("div", { class: "menu row-menu", role: "menu" }, nodes);
  menu.style.position = "fixed";
  menu.style.top = `${Math.round(box.bottom + 4)}px`;
  if (left) menu.style.left = `${Math.max(8, Math.round(box.left))}px`; else menu.style.right = `${Math.max(8, Math.round(window.innerWidth - box.right))}px`;
  document.body.append(menu);
}
const menuItem = (label, run, o = {}) => h("button", { role: "menuitem", class: o.danger ? "danger-item" : "", onclick: () => { closeMenus(); run(); } }, label);
const menuLink = (label, href) => h("a", { role: "menuitem", class: "menu-link", href, target: "_blank", rel: "noopener noreferrer", onclick: () => closeMenus() }, label);
const REPO = "https://github.com/Malick44/baas";

function appbar(project) {
  const initials = (S.me?.organization.name || "?").slice(0, 2).toUpperCase();
  const avatar = h("button", { class: "avatar", id: "avatar", "aria-label": "Account menu", title: "Account", onclick: (e) => {
    e.stopPropagation();
    if (document.querySelector(".menu")) return closeMenus();
    document.body.append(h("div", { class: "menu", role: "menu" },
      h("div", { class: "who", id: "who" }, S.me.member && h("div", { id: "who-email" }, S.me.member.email), h("div", null, S.me.organization.name), h("div", { class: "muted" }, `${S.me.role} · ${S.me.organization.slug}`)),
      h("button", { role: "menuitem", onclick: () => { closeMenus(); location.hash = "#/projects"; } }, "All projects"),
      S.me.role !== "developer" && h("button", { role: "menuitem", id: "menu-team", onclick: () => { closeMenus(); location.hash = "#/team"; } }, "Team"),
      S.me.member && h("button", { role: "menuitem", id: "menu-password", onclick: () => { closeMenus(); passwordDialog(); } }, "Change password"),
      S.me.member && h("button", { role: "menuitem", id: "menu-mfa", onclick: () => { closeMenus(); mfaDialog(); } }, "Two-step verification"),
      h("button", { role: "menuitem", id: "signout", onclick: logout }, "Sign out")));
  } }, initials);
  const search = h("button", { class: "searchbox", id: "open-palette", title: "Search pages (Ctrl/⌘+K)", onclick: openPalette }, icon("search", 15), h("span", null, "Search…"), h("kbd", null, "⌘K"));
  const switcher = (id, label, build) => h("button", { class: "crumb-switch", id, "aria-label": label, title: label, onclick: async (e) => {
    const ev = { stopPropagation: () => e.stopPropagation(), currentTarget: e.currentTarget };
    showMenu(ev, await build(), { left: true });
  } }, icon("chevrons", 14));
  const orgSwitch = switcher("org-switch", "Organisation", () => [
    h("div", { class: "who" }, h("div", null, S.me.organization.name), h("div", { class: "muted" }, `${S.me.role} · ${S.me.organization.slug}`)),
    menuItem("All projects", () => { location.hash = "#/projects"; })]);
  const projectSwitch = project && switcher("project-switch", "Switch project", async () => {
    let rows = [];
    try { rows = await api("GET", "/v1/projects"); } catch { /* menu still offers the list page */ }
    return [h("div", { class: "menu-title" }, "Projects"),
      ...rows.map((r) => h("button", { role: "menuitem", class: r.ref === project.ref ? "current" : "", "data-ref": r.ref, onclick: () => { closeMenus(); location.hash = `#/p/${r.ref}/overview`; } }, r.name, h("span", { class: `chip ${r.status}` }, r.status))),
      menuItem("All projects", () => { location.hash = "#/projects"; })];
  });
  const branchSwitch = project && switcher("branch-switch", "Branch", () => [
    h("div", { class: "menu-title" }, "Branches"),
    h("button", { role: "menuitem", class: "current" }, "main", h("span", { class: "chip env" }, "production")),
    h("p", { class: "muted menu-note" }, "This project runs a single production database. Preview branches are not part of baas yet.")]);
  const sql = project && h("a", { class: "iconbtn extra", id: "cli-btn", href: "#", title: "Use from the command line", "aria-label": "Command line", onclick: (e) => { e.preventDefault(); cliDialog(project); } }, icon("terminal", 16));
  const help = h("button", { class: "iconbtn extra", id: "help-btn", title: "Help", "aria-label": "Help", onclick: (e) => showMenu(e, [
    menuLink("Documentation", `${REPO}#readme`), menuLink("Report a problem", `${REPO}/issues/new`),
    menuItem("Keyboard shortcuts", () => shortcutsDialog())]) }, icon("help", 16));
  return h("header", { class: "appbar" },
    h("a", { class: "logo", href: "#/projects", title: "All projects", "aria-label": "baas" }, LOGO()),
    h("span", { class: "sep org" }, "/"),
    h("span", { class: "crumb-group org" }, h("a", { class: "crumb", href: "#/projects" }, S.me?.organization.name || "", project && h("span", { class: "chip" }, project.plan)), orgSwitch),
    project && [h("span", { class: "sep" }, "/"),
      h("span", { class: "crumb-group" }, h("a", { class: "crumb", href: `#/p/${project.ref}/overview`, id: "crumb-project" }, project.name), projectSwitch),
      h("span", { class: `chip ${project.status}`, id: "project-status" }, project.status),
      h("span", { class: "sep org" }, "/"),
      h("span", { class: "crumb-group org" }, h("span", { class: "crumb", id: "branch-crumb" }, "main", h("span", { class: "chip env" }, "production")), branchSwitch)],
    project && h("button", { id: "connect-btn", onclick: () => connectDialog(project) }, icon("plug", 15), " Connect"),
    h("span", { class: "spacer" }),
    h("button", { class: "plain extra", id: "feedback-btn", onclick: feedbackDialog }, "Feedback"),
    search, help,
    project && h("a", { class: "iconbtn extra", id: "advisors-btn", href: `#/p/${project.ref}/advisors`, title: "Advisors", "aria-label": "Advisors" }, icon("bulb", 16)),
    sql,
    project && h("a", { class: "iconbtn extra", id: "ask-ai-btn", href: `#/p/${project.ref}/ai`, title: "Ask AI", "aria-label": "Ask AI" }, icon("diamond", 16)),
    avatar);
}

function feedbackDialog() {
  return dialog("Send feedback", () => h("div", { class: "stack" },
    h("p", { class: "muted" }, "Feedback is tracked as an issue on the baas repository. Write it here and it opens on GitHub, where you can review it before sending. Nothing is sent from this page."),
    h("textarea", { name: "text", id: "feedback-text", rows: 6, placeholder: "What would make this better?", required: true })), {
    confirmLabel: "Open on GitHub",
    onSubmit: (fd) => {
      const text = String(fd.get("text")).trim();
      if (!text) throw new Error("Write something first.");
      window.open(`${REPO}/issues/new?title=${encodeURIComponent("Dashboard feedback")}&body=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
      return true;
    },
  });
}

function shortcutsDialog() {
  const rows = [["Ctrl/⌘ + K", "Search pages"], ["Ctrl/⌘ + Enter", "Run the SQL, or send the Ask AI question"], ["Esc", "Close a dialog, panel or menu"]];
  return dialog("Keyboard shortcuts", () => h("table", { class: "data" }, h("tbody", null, rows.map(([k, d]) => h("tr", null, h("td", null, h("kbd", { class: "key" }, k)), h("td", null, d))))), { confirmLabel: "Close" });
}

function cliDialog(p) {
  const url = location.origin;
  return dialog("Use this project from the command line", () => h("div", { class: "stack" },
    h("p", { class: "muted" }, "The baas CLI talks to the management API with an API token. Link this folder to the project, then push migrations or ask questions."),
    h("pre", { id: "cli-snippet" }, `npx baas login --url ${url} --token <your token>\nnpx baas link ${p.ref}\nnpx baas db push\nnpx baas ask "how many rows are in my biggest table?"`),
    h("p", { class: "muted" }, "Create a token under your organisation, and keep it out of source control.")), { confirmLabel: "Close" });
}

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
  if (S.me?.role !== "developer") out.push(["Team", "#/team"]);
  for (const n of NAV) if (n.id && n.id !== "database") out.push([n.label, `#/p/${ref}/${n.id}`]);
  for (const g of DB_MENU) for (const [id, label, tabId] of g.items) if (!tabId) out.push([`Database › ${label}`, `#/p/${ref}/database/${id}`]);
  for (const g of AUTH_MENU) for (const [id, label] of g.items) out.push([`Authentication › ${label}`, `#/p/${ref}/auth/${id}`]);
  return out;
}
function openPalette() {
  const ref = S.project?.ref;
  const entries = ref ? pageIndex(ref) : [["Projects", "#/projects"], ...(S.me?.role !== "developer" ? [["Team", "#/team"]] : [])];
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
function startSession(token, remember) {
  S.token = token;
  S.me = null;
  localStorage.removeItem("baas.token");
  sessionStorage.removeItem("baas.token");
  (remember ? localStorage : sessionStorage).setItem("baas.token", token);
}

function renderLogin() {
  const memberErr = h("div", { class: "notice bad", hidden: true, id: "member-error" });
  const email = h("input", { id: "login-email", name: "email", type: "email", autocomplete: "username", placeholder: "you@example.com", required: true });
  const password = h("input", { id: "login-password", name: "password", type: "password", autocomplete: "current-password", required: true });
  const rememberMember = h("input", { type: "checkbox", id: "remember-member" });
  const memberForm = h("form", { class: "stack", id: "member-form" },
    h("h1", null, "Sign in"),
    h("label", { class: "field" }, "Email", email),
    h("label", { class: "field" }, "Password", password),
    h("label", { class: "check" }, rememberMember, "Remember on this device"),
    memberErr,
    h("button", { class: "primary", type: "submit", id: "signin-member" }, "Sign in"));
  const forgot = h("button", { type: "button", class: "linkish", id: "forgot-password", hidden: true, onclick: () => forgotDialog(email.value) }, "Forgot password?");
  fetch("/v1/config").then((r) => r.json()).then((c) => { forgot.hidden = !c.member_email_reset; }).catch(() => {});
  memberForm.insertBefore(forgot, memberErr);
  const finish = (data) => { startSession(data.token, rememberMember.checked); go("#/projects"); };
  memberForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await fetch("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.value, password: password.value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      if (data.mfa_required) return codeStep(data.mfa_token);
      finish(data);
    } catch (ex) {
      memberErr.hidden = false;
      memberErr.textContent = ex.message;
    }
  });
  /** The second step: the six digits from the authenticator app, or a recovery code. */
  function codeStep(ticket) {
    const err2 = h("div", { class: "notice bad", hidden: true, id: "code-error" });
    const code = h("input", { id: "login-code", name: "code", autocomplete: "one-time-code", inputmode: "text", required: true, placeholder: "123456" });
    const f2 = h("form", { class: "stack", id: "code-form" },
      h("h1", null, "Two-step verification"),
      h("p", { class: "muted" }, "Enter the 6-digit code from your authenticator app, or one of your recovery codes."),
      h("label", { class: "field" }, "Code", code), err2,
      h("button", { class: "primary", type: "submit", id: "verify-code" }, "Verify"),
      h("button", { type: "button", class: "linkish", onclick: () => renderLogin() }, "Back"));
    f2.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const res = await fetch("/v1/auth/mfa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mfa_token: ticket, code: code.value }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
        finish(data);
      } catch (ex) { err2.hidden = false; err2.textContent = ex.message; }
    });
    mount(h("div", { class: "login" }, h("div", { class: "card" }, f2)));
    code.focus();
  }

  const err = h("div", { class: "notice bad", hidden: true, id: "login-error" });
  const token = h("input", { id: "token", name: "token", type: "password", autocomplete: "off", placeholder: "baas_…", required: true });
  const remember = h("input", { type: "checkbox", id: "remember" });
  const form = h("form", { class: "stack" },
    h("h3", null, "Or use an API token"),
    h("p", { class: "muted" }, "Tokens are for scripts and for organisations that have no member accounts yet. They are created with the bootstrap secret or by an owner."),
    h("label", { class: "field" }, "API token", token),
    h("label", { class: "check" }, remember, "Remember on this device"),
    err,
    h("button", { type: "submit", id: "signin" }, "Sign in with token"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    S.token = token.value.trim();
    try {
      S.me = await api("GET", "/v1/me");
      (remember.checked ? localStorage : sessionStorage).setItem("baas.token", S.token);
      go("#/projects");
    } catch (ex) {
      S.token = null;
      err.hidden = false;
      err.textContent = ex.message;
    }
  });
  mount(h("div", { class: "login" }, h("div", { class: "card stack" }, memberForm, h("hr"), form)));
}

/** The page an invitation link opens: choose a password and join. The token stays in the URL fragment, which is never sent to a server. */
function renderInvite(token) {
  const err = h("div", { class: "notice bad", hidden: true, id: "invite-error" });
  const name = h("input", { id: "invite-name", name: "name", autocomplete: "name", placeholder: "Your name (optional)" });
  const pw = h("input", { id: "invite-password", name: "password", type: "password", autocomplete: "new-password", required: true, minlength: 8 });
  const again = h("input", { id: "invite-confirm", name: "confirm", type: "password", autocomplete: "new-password", required: true });
  const form = h("form", { class: "stack", id: "invite-form" },
    h("h1", null, "Join your team"),
    h("p", { class: "muted" }, "Choose a password to finish creating your account."),
    h("label", { class: "field" }, "Name", name),
    h("label", { class: "field" }, "Password", pw, h("span", { class: "muted hint" }, "At least 8 characters.")),
    h("label", { class: "field" }, "Repeat password", again),
    err,
    h("button", { class: "primary", type: "submit", id: "accept-invite" }, "Create account"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      if (pw.value !== again.value) throw new Error("The passwords do not match.");
      const res = await fetch("/v1/auth/accept-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: pw.value, name: name.value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      startSession(data.token, false);
      go("#/projects");
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message;
    }
  });
  mount(h("div", { class: "login" }, h("div", { class: "card" }, form)));
}

function forgotDialog(prefill) {
  return dialog("Reset your password", () => h("div", { class: "stack" },
    h("p", { class: "muted" }, "Enter your account's email address. If it has an account, we send a link that lets you choose a new password."),
    h("input", { name: "email", id: "forgot-email", type: "email", required: true, value: prefill || "", autocomplete: "username" })), {
    confirmLabel: "Send link",
    onSubmit: async (fd) => {
      const res = await fetch("/v1/auth/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: fd.get("email") }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      toast("If that address has an account, a link is on its way", "ok");
      return true;
    },
  });
}

/** The page a reset email opens. The token stays in the URL fragment, which is never sent to a server. */
function renderReset(token) {
  const err = h("div", { class: "notice bad", hidden: true, id: "reset-error" });
  const pw = h("input", { id: "reset-new", name: "password", type: "password", autocomplete: "new-password", required: true, minlength: 8 });
  const again = h("input", { id: "reset-again", name: "again", type: "password", autocomplete: "new-password", required: true });
  const form = h("form", { class: "stack", id: "reset-form" },
    h("h1", null, "Choose a new password"),
    h("p", { class: "muted" }, "You will be signed out everywhere and asked to sign in again."),
    h("label", { class: "field" }, "New password", pw, h("span", { class: "muted hint" }, "At least 8 characters.")),
    h("label", { class: "field" }, "Repeat password", again), err,
    h("button", { class: "primary", type: "submit", id: "do-reset" }, "Set password"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      if (pw.value !== again.value) throw new Error("The passwords do not match.");
      const res = await fetch("/v1/auth/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: pw.value }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
      S.token = S.me = null;
      localStorage.removeItem("baas.token"); sessionStorage.removeItem("baas.token");
      go("");
      toast("Password changed. Sign in with the new one.", "ok");
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
  });
  mount(h("div", { class: "login" }, h("div", { class: "card" }, form)));
}

/** Set up or remove the authenticator app for the signed-in member. */
async function mfaDialog() {
  const on = S.me.member?.mfa;
  if (on) {
    await dialog("Two-step verification", () => h("div", { class: "stack" },
      h("p", null, h("span", { class: "chip healthy", id: "mfa-state" }, "On"), " Signing in needs a code from your authenticator app."),
      h("p", { class: "muted" }, "To turn it off, confirm with your password and a current code (or a recovery code)."),
      h("label", { class: "field" }, "Password", h("input", { name: "password", id: "mfa-off-password", type: "password", autocomplete: "current-password", required: true })),
      h("label", { class: "field" }, "Code", h("input", { name: "code", id: "mfa-off-code", autocomplete: "one-time-code", required: true }))), {
      confirmLabel: "Turn off", danger: true,
      onSubmit: async (fd) => { await api("POST", "/v1/me/mfa/disable", { password: fd.get("password"), code: fd.get("code") }); toast("Two-step verification is off", "ok"); return true; },
    });
  } else {
    let started = null;
    try { started = await api("POST", "/v1/me/mfa/enroll"); } catch (ex) { toast(ex.message, "bad"); return; }
    let codes = null;
    const ok = await dialog("Set up two-step verification", () => h("div", { class: "stack" },
      h("p", { class: "muted" }, "In an authenticator app (1Password, Authy, Google Authenticator…), add an account with this key, then enter the 6-digit code it shows."),
      h("div", { class: "kv", id: "mfa-secret" }, h("span", { class: "k" }, "Key"), ...copyable(started.secret), h("span", { class: "k" }, "Link"), ...copyable(started.uri)),
      h("label", { class: "field" }, "Code from the app", h("input", { name: "code", id: "mfa-code", autocomplete: "one-time-code", inputmode: "numeric", required: true, pattern: "[0-9]{6}", placeholder: "123456" }))), {
      confirmLabel: "Turn on",
      onSubmit: async (fd) => { codes = (await api("POST", "/v1/me/mfa/verify", { code: fd.get("code") })).recovery_codes; return true; },
    });
    if (!ok) return;
    await dialog("Save your recovery codes", () => h("div", { class: "stack" },
      h("p", null, "Each code works once if you lose your device. They are shown only now: store them somewhere safe."),
      h("pre", { id: "recovery-codes" }, codes.join("\n")),
      h("button", { type: "button", onclick: async () => { await navigator.clipboard?.writeText(codes.join("\n")).catch(() => {}); toast("Copied"); } }, "Copy codes")), { confirmLabel: "I have saved them" });
  }
  S.me = await api("GET", "/v1/me");
}

function passwordDialog() {
  return dialog("Change password", () => h("div", { class: "stack" },
    h("label", { class: "field" }, "Current password", h("input", { name: "current", id: "pw-current", type: "password", autocomplete: "current-password", required: true })),
    h("label", { class: "field" }, "New password", h("input", { name: "next", id: "pw-new", type: "password", autocomplete: "new-password", required: true, minlength: 8 })),
    h("label", { class: "field" }, "Repeat new password", h("input", { name: "again", id: "pw-again", type: "password", autocomplete: "new-password", required: true })),
    h("p", { class: "muted" }, "Your other signed-in devices are signed out.")), {
    confirmLabel: "Change password",
    onSubmit: async (fd) => {
      if (fd.get("next") !== fd.get("again")) throw new Error("The new passwords do not match.");
      await api("POST", "/v1/me/password", { current_password: fd.get("current"), new_password: fd.get("next") });
      toast("Password changed", "ok");
      return true;
    },
  });
}

// ---------- team ----------
async function renderTeam() {
  const box = h("div", { class: "stack", id: "team" }, h("p", { class: "muted" }, "Loading…"));
  const canInvite = S.me.role !== "developer";
  mount(shell(
    h("div", { class: "row between" }, h("h1", null, "Team"),
      h("button", { class: "primary", id: "invite-member", disabled: !canInvite, onclick: () => inviteDialog(draw) }, "Invite member")),
    box));
  if (!canInvite) { clear(box); box.append(h("div", { class: "empty card" }, "Managing the team requires the admin role.")); return; }
  const ranks = ["developer", "admin", "owner"];
  const mine = ranks.indexOf(S.me.role);
  async function draw() {
    const { members, invites } = await api("GET", "/v1/members");
    clear(box);
    if (!members.length) box.append(h("div", { class: "notice", id: "no-members" }, "Nobody has a member account yet. Invite people by email, and they sign in with a password instead of sharing an API token."));
    box.append(h("div", { class: "card" }, h("table", { class: "data", id: "members-table" },
      h("thead", null, h("tr", null, ["Member", "Role", "Joined", ""].map((x) => h("th", null, x)))),
      h("tbody", null, members.map((m) => {
        const you = m.id === S.me.member?.id;
        const above = ranks.indexOf(m.role) > mine;
        return h("tr", { "data-member": m.email }, h("td", null, m.name ? [h("div", null, m.name), h("div", { class: "muted" }, m.email)] : m.email, you && h("span", { class: "chip" }, "you"), m.mfa && h("span", { class: "chip healthy", "data-mfa": "on", title: "Signs in with an authenticator" }, "2-step")),
          h("td", null, m.role), h("td", { class: "muted" }, new Date(m.created_at).toLocaleDateString()),
          h("td", { class: "right" }, rowMenu([
            ["Change role", () => roleDialog(m, draw), { action: "member-role", disabled: above, why: above ? "You cannot change someone with a higher role" : "" }],
            ...(m.mfa && !above && S.me.role === "owner" && !you ? [["Remove authenticator", async () => {
              if (!(await confirmBox("Remove authenticator", `Remove ${m.email}'s second factor? Use this when they lost their device and recovery codes. Anyone with their password can then sign in without a code.`, { confirmLabel: "Remove authenticator" }))) return;
              try { await api("DELETE", `/v1/members/${m.id}/mfa`); toast("Authenticator removed", "ok"); draw(); } catch (ex) { toast(ex.message, "bad"); }
            }, { danger: true, action: "member-remove-mfa" }]] : []),
            ["Set new password", () => resetDialog(m), { action: "member-password", disabled: S.me.role !== "owner" || you, why: S.me.role !== "owner" ? "Only owners can set another member's password" : "" }],
            [you ? "Leave organisation" : "Remove from organisation", async () => {
              if (!(await confirmBox(you ? "Leave organisation" : "Remove member", you ? "You will be signed out." : `Remove ${m.email}? They are signed out everywhere and can only return by invitation.`, { confirmLabel: you ? "Leave" : "Remove" }))) return;
              try { await api("DELETE", `/v1/members/${m.id}`); toast(you ? "You left" : "Member removed", "ok"); if (you) logout(); else draw(); } catch (ex) { toast(ex.message, "bad"); }
            }, { danger: true, action: "member-remove", disabled: above }]]))); })))));
    if (invites.length) box.append(h("div", { class: "card stack" }, h("h3", null, "Pending invitations"),
      h("table", { class: "data", id: "invites-table" }, h("tbody", null, invites.map((i) =>
        h("tr", { "data-invite": i.email }, h("td", null, i.email), h("td", null, i.role),
          h("td", { class: "muted" }, i.expired ? "expired" : `expires ${new Date(i.expires_at).toLocaleDateString()}`),
          h("td", { class: "right" }, h("button", { class: "small", "data-action": "revoke-invite", onclick: async () => { try { await api("DELETE", `/v1/members/invites/${i.id}`); toast("Invitation revoked", "ok"); draw(); } catch (ex) { toast(ex.message, "bad"); } } }, "Revoke"))))))));
    box.append(h("p", { class: "muted" }, "Invitation links are shown once, when you create them. API tokens for scripts are separate and still work."));
  }
  await draw();
}

async function inviteDialog(done) {
  const roles = ["developer", "admin", "owner"].filter((r) => ["developer", "admin", "owner"].indexOf(r) <= ["developer", "admin", "owner"].indexOf(S.me.role));
  let made = null;
  await dialog("Invite a member", () => h("div", { class: "stack" },
    h("label", { class: "field" }, "Email", h("input", { name: "email", id: "invite-email", type: "email", required: true, placeholder: "teammate@example.com" })),
    h("label", { class: "field" }, "Role", h("select", { name: "role", id: "invite-role" }, roles.map((r) => h("option", { value: r }, r)))),
    h("p", { class: "muted" }, "Developers can use projects; admins can also create projects and invite people; owners manage everything. You get a link to send them.")), {
    confirmLabel: "Create invitation",
    onSubmit: async (fd) => { made = await api("POST", "/v1/members/invites", { email: fd.get("email"), role: fd.get("role") }); return true; },
  });
  if (!made) return;
  const link = `${location.origin}/#/invite/${made.token}`;
  await dialog("Invitation ready", () => h("div", { class: "stack" },
    h("p", null, `Send this link to ${made.invite.email}. It works once and expires in 7 days.`),
    h("div", { class: "kv", id: "invite-link" }, h("span", { class: "k" }, "Link"), ...copyable(link))), { confirmLabel: "Done" });
  done();
}

async function roleDialog(m, done) {
  const ranks = ["developer", "admin", "owner"];
  const roles = ranks.filter((r) => ranks.indexOf(r) <= ranks.indexOf(S.me.role));
  await dialog("Change role", () => h("div", { class: "stack" },
    h("p", null, m.email),
    h("select", { name: "role", id: "role-select" }, roles.map((r) => h("option", { value: r, selected: r === m.role }, r)))), {
    confirmLabel: "Save",
    onSubmit: async (fd) => { await api("PATCH", `/v1/members/${m.id}`, { role: fd.get("role") }); toast("Role updated", "ok"); return true; },
  });
  done();
}

function resetDialog(m) {
  return dialog("Set a new password", () => h("div", { class: "stack" },
    h("p", null, `Choose a temporary password for ${m.email} and tell them. They are signed out everywhere, and can change it from their account menu.`),
    h("input", { name: "password", id: "reset-password", type: "password", autocomplete: "new-password", required: true, minlength: 8 })), {
    confirmLabel: "Set password",
    onSubmit: async (fd) => { await api("POST", `/v1/members/${m.id}/password`, { password: fd.get("password") }); toast("Password set", "ok"); return true; },
  });
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
  { id: "advisors", label: "Advisors", icon: "bulb" },
  { id: "reports", label: "Reports", icon: "chart" },
  { id: "integrations", label: "Integrations", icon: "grid" },
  { id: "logs", label: "Logs", icon: "list" },
  { grow: true },
  { id: "settings", label: "Project settings", icon: "settings" },
];
const DB_MENU = [
  { title: "Database management", items: [["schema", "Schema Visualizer"], ["tables", "Tables"], ["functions", "Functions"], ["triggers", "Triggers"], ["enums", "Enumerated Types"], ["extensions", "Extensions"], ["indexes", "Indexes"], ["publications", "Publications"]] },
  { title: "Access control", items: [["policies", "Policies"], ["roles", "Roles"]] },
  { title: "Configuration", items: [["settings", "Settings", "settings"]] },
  { title: "Platform", items: [["pipelines", "Pipelines", null, true], ["backups", "Backups"], ["migrations", "Migrations"]] },
];
const AUTH_MENU = [
  { title: "Manage", items: [["users", "Users"]] },
  { title: "Configuration", items: [["providers", "Sign-in providers"], ["urls", "URL configuration"], ["email", "Email"], ["sessions", "Sessions and sign-ups"]] },
];
/** Sections with their own second sidebar. */
const SUBMENUS = { database: { menu: DB_MENU, first: "schema", title: "Database" }, auth: { menu: AUTH_MENU, first: "users", title: "Authentication" } };
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
  const subm = SUBMENUS[tab];
  if (subm && !subm.menu.some((g) => g.items.some(([id]) => id === page))) page = subm.first;
  const body = h("div", { id: "tab-body", "data-page": subm ? `${tab}/${page}` : tab }, h("p", { class: "muted" }, "Loading…"));
  const rail = h("nav", { class: "rail", "aria-label": "Project sections" }, NAV.map((n) =>
    n.divider ? h("div", { class: "divider" }) : n.grow ? h("div", { class: "grow" })
      : h("a", { href: `#/p/${ref}/${SUBMENUS[n.id] ? `${n.id}/${SUBMENUS[n.id].first}` : n.id}`, class: n.id === tab ? "on" : "", "data-tab": n.id, title: n.label, "aria-label": n.label }, icon(n.icon, 19))));
  const sub = subm ? h("nav", { class: "sub", "aria-label": subm.title }, h("div", { class: "title" }, subm.title),
    subm.menu.map((g) => [h("div", { class: "group label" }, g.title), g.items.map(([id, label, tabId, isNew]) => h("a", { href: tabId ? `#/p/${ref}/${tabId}` : `#/p/${ref}/${tab}/${id}`, class: !tabId && id === page ? "on" : "", "data-dbpage": id }, label, isNew ? h("span", { class: "new" }, "NEW") : null))])) : null;
  let hidden = false;
  try { hidden = localStorage.getItem("baas.sub.hidden") === "1"; } catch { /* ignore */ }
  const frame = h("div", { class: `frame ${sub ? "with-sub" : ""} ${sub && hidden ? "sub-hidden" : ""}` });
  if (sub) rail.append(h("button", { class: "iconbtn rail-toggle", id: "toggle-sub", title: "Collapse the sidebar", "aria-label": "Collapse sidebar", "aria-pressed": String(hidden), onclick: (e) => {
    const now = frame.classList.toggle("sub-hidden");
    e.currentTarget.setAttribute("aria-pressed", String(now));
    try { localStorage.setItem("baas.sub.hidden", now ? "1" : "0"); } catch { /* ignore */ }
  } }, icon("panel", 16)));
  mount(h("div", null, appbar(p),
    frame));
  frame.append(...[rail, sub,
    h("main", { class: "content" },
      p.status === "paused" && h("div", { class: "notice warn", id: "paused-note" }, "This project is paused: its API is offline. Resume it in Project settings."),
      body)].filter(Boolean));
  const fn = { overview, tables, sql, ai, advisors, reports, integrations, storage, functions, realtime, logs, settings }[tab];
  try {
    if (tab === "database") await dbPage(body, p, page);
    else if (tab === "auth") await authPage(body, p, page);
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
  const aiPrefill = sessionStorage.getItem("baas.ai.prefill");
  if (aiPrefill) { input.value = aiPrefill; sessionStorage.removeItem("baas.ai.prefill"); }
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
  const state = { schema: "public", q: "", filters: {} };
  const ctx = { state, schemas: ["public"] };
  let schemas = ["public"];
  if (cfg.schemas !== false) schemas = (await catalog(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by (nspname = 'public') desc, nspname`)).map((r) => r.nspname);
  ctx.schemas = schemas;
  const holder = h("div", { class: "tablewrap", id: "catalog-table" });
  const note = h("p", { class: "muted pagehint" }, cfg.hint || "");
  let rows = [];
  const cellFor = (c, r) => {
    const v = c.cell ? c.cell(r, load, ctx) : r[c.key];
    const missing = v === null || v === undefined;
    const text = missing ? "—" : v instanceof Node ? v : truncate(String(v), c.max || 80);
    return h("td", { class: `${c.mono ? "mono-cell" : ""} ${missing ? "null" : ""}`, title: typeof v === "string" ? v.slice(0, 300) : "" }, text);
  };
  const draw = () => {
    clear(holder);
    const q = state.q.toLowerCase();
    const shown = rows.filter((r) => (!q || Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q)))
      && (cfg.filters || []).every((f) => !state.filters[f.id] || f.test(r, state.filters[f.id])));
    if (!shown.length) { holder.append(h("div", { class: "empty" }, rows.length ? "No matches." : cfg.empty)); return; }
    const head = h("tr", null, cfg.cols.map((c) => h("th", null, c.label)), cfg.actions ? h("th") : null);
    const bodyRows = shown.map((r) => {
      const tr = h("tr", { "data-row": r.name ?? "" }, cfg.cols.map((c) => cellFor(c, r)));
      if (cfg.actions) tr.append(h("td", { class: "actions-cell" }, h("div", { class: "row" }, cfg.actions(r, load, ctx))));
      return tr;
    });
    holder.append(h("table", { class: "data" }, h("thead", null, head), h("tbody", null, bodyRows)));
  };
  const load = async () => {
    try { rows = await catalog(cfg.query(state.schema, p)); fillFilters(); draw(); }
    catch (ex) { clear(holder); holder.append(h("div", { class: "empty" }, cfg.emptyOnError ? cfg.emptyOnError : ex.message)); }
  };
  const filterEls = (cfg.filters || []).map((f) => h("select", { class: "filter", id: `filter-${f.id}`, "aria-label": f.label, onchange: (e) => { state.filters[f.id] = e.target.value; draw(); } }, h("option", { value: "" }, f.label)));
  const fillFilters = () => (cfg.filters || []).forEach((f, i) => {
    const el = filterEls[i], keep = state.filters[f.id] || "";
    while (el.options.length > 1) el.remove(1);
    for (const v of f.values(rows)) el.append(h("option", { value: v }, v));
    el.value = [...el.options].some((o) => o.value === keep) ? keep : "";
    state.filters[f.id] = el.value;
  });
  const search = h("input", { id: "catalog-search", placeholder: cfg.searchPlaceholder || "Search", "aria-label": "Search", oninput: (e) => { state.q = e.target.value; draw(); } });
  const schemaSel = cfg.schemas === false ? null : h("select", { id: "catalog-schema", "aria-label": "Schema", onchange: (e) => { state.schema = e.target.value; load(); } }, schemas.map((s) => h("option", { value: s }, `schema ${s}`)));
  clear(body);
  body.append(h("div", null,
    h("div", { class: "page-head" }, h("h1", null, cfg.title),
      cfg.docs ? h("a", { class: "button docs", href: cfg.docs, target: "_blank", rel: "noopener noreferrer" }, icon("book", 15), " Docs") : null,
      cfg.headAction ? cfg.headAction(load) : null),
    cfg.hint && note,
    h("div", { class: "toolbar" }, schemaSel, search, filterEls, h("span", { class: "spacer" }), cfg.toolbarAction ? cfg.toolbarAction(load, ctx) : null),
    holder));
  await load();
}

const definitionDialog = (title, sqlText, extra) => dialog(title, () => h("div", { class: "stack" }, h("pre", { class: "sql" }, sqlText), extra), { confirmLabel: "Close" });

/** Quote an identifier for SQL, whatever characters it has. */
const qid = (x) => `"${String(x).replace(/"/g, '""')}"`;
const qlit = (x) => `'${String(x).replace(/'/g, "''")}'`;
const formRow = (label, el, hint) => h("div", { class: "form-row" }, h("label", null, label), h("div", null, el, hint ? h("p", { class: "muted hint" }, hint) : null));
/** A read-only box showing the SQL a form will run, so nothing is hidden. */
function sqlPreview() {
  const pre = h("pre", { class: "sql-preview", id: "sql-preview" });
  return { el: pre, set: (t) => { pre.textContent = t; } };
}
const tablesIn = async (schema) => catalog(`select c.relname as name, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${pgLit(schema)} and c.relkind in ('r', 'p') order by c.relname`);
const columnsOf = async (schema, table) => (await catalog(`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${pgLit(schema)} and c.relname = ${pgLit(table)} and a.attnum > 0 and not a.attisdropped order by a.attnum`));
const NO_SEMI = (what, v) => { if (/;/.test(v)) throw new Error(`${what} must be a single expression: remove the semicolon.`); return v.trim(); };

// ---------- policies ----------
const POLICY_TEMPLATES = {
  "": { label: "Start from a template…" },
  public_read: { label: "Anyone can read every row", cmd: "SELECT", roles: ["anon", "authenticated"], using: "true", check: "" },
  signed_in_read: { label: "Signed-in users can read every row", cmd: "SELECT", roles: ["authenticated"], using: "true", check: "" },
  own_rows: { label: "Users can only see and change their own rows", cmd: "ALL", roles: ["authenticated"], using: "auth.uid() = {owner}", check: "auth.uid() = {owner}" },
  own_read: { label: "Users can only read their own rows", cmd: "SELECT", roles: ["authenticated"], using: "auth.uid() = {owner}", check: "" },
  own_insert: { label: "Users can insert rows as themselves", cmd: "INSERT", roles: ["authenticated"], using: "", check: "auth.uid() = {owner}" },
};

/** The right-hand panel for creating or editing a row-level security policy. */
async function policySheet(pol, reload, ctx) {
  const schema = pol ? pol.schema : ctx.state.schema;
  const tables = await tablesIn(schema);
  if (!tables.length) { toast(`There are no tables in schema ${schema} yet. Create a table first.`, "bad"); return; }
  const prev = sqlPreview();
  const name = h("input", { id: "pol-name", placeholder: "e.g. Users can read their own rows", autocomplete: "off", value: pol ? pol.name : "" });
  const table = h("select", { id: "pol-table", disabled: !!pol }, tables.map((t) => h("option", { value: t.name }, t.name)));
  if (pol) table.value = pol.table;
  const cmd = h("select", { id: "pol-cmd", disabled: !!pol }, ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"].map((c) => h("option", { value: c }, c)));
  cmd.value = pol ? pol.command : "SELECT";
  const kind = h("select", { id: "pol-kind", disabled: !!pol }, [["PERMISSIVE", "Permissive (any matching policy grants access)"], ["RESTRICTIVE", "Restrictive (must also pass, narrows other policies)"]].map(([v, l]) => h("option", { value: v }, l)));
  kind.value = pol ? pol.permissive.toUpperCase() : "PERMISSIVE";
  const wantRoles = pol ? pol.roles.split(",").map((x) => x.trim()) : ["authenticated"];
  const roleBoxes = [["anon", "anon (not signed in)"], ["authenticated", "authenticated (signed in)"], ["public", "public (everyone)"]].map(([r, label]) =>
    h("label", { class: "check" }, h("input", { type: "checkbox", "data-role": r, checked: wantRoles.includes(r) }), label));
  const using = h("textarea", { id: "pol-using", class: "code", rows: 3, spellcheck: "false", placeholder: "auth.uid() = user_id" }, pol?.using || "");
  const check = h("textarea", { id: "pol-check", class: "code", rows: 3, spellcheck: "false", placeholder: "auth.uid() = user_id" }, pol?.check || "");
  const usingRow = formRow("Using expression", using, "Which existing rows the policy applies to. For reads, updates and deletes.");
  const checkRow = formRow("With check expression", check, "Which new or changed rows are allowed. For inserts and updates. If left empty on an update, the using expression is used.");
  const enableRls = h("input", { type: "checkbox", id: "pol-enable-rls", checked: true });
  const rlsRow = h("div", { class: "notice warn", id: "pol-rls-note", hidden: true }, h("label", { class: "check" }, enableRls, "Row-level security is off on this table, so this policy would do nothing. Turn it on."));
  const tpl = h("select", { id: "pol-template", "aria-label": "Template" }, Object.entries(POLICY_TEMPLATES).map(([k, v]) => h("option", { value: k }, v.label)));
  let cols = [];
  const owner = () => (cols.find((c) => /^(user_id|owner_id|owner|created_by|author_id)$/.test(c.name)) || { name: "user_id" }).name;

  const roles = () => roleBoxes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.dataset.role);
  const wants = () => ({ using: cmd.value !== "INSERT", check: cmd.value === "INSERT" || cmd.value === "ALL" || cmd.value === "UPDATE" });
  const sqlText = () => {
    const t = `${qid(schema)}.${qid(table.value)}`;
    const w = wants();
    const to = roles().length ? roles().join(", ") : "public";
    const u = w.using && using.value.trim() ? `\n  using (${using.value.trim()})` : "";
    const c = w.check && check.value.trim() ? `\n  with check (${check.value.trim()})` : "";
    const head = [];
    if (!pol && enableRls.checked && !rlsRow.hidden) head.push(`alter table ${t} enable row level security;`);
    if (!pol) return [...head, `create policy ${qid(name.value || "policy name")} on ${t}\n  as ${kind.value.toLowerCase()} for ${cmd.value.toLowerCase()} to ${to}${u}${c};`].join("\n");
    const out = [`alter policy ${qid(pol.name)} on ${t}\n  to ${to}${u}${c};`];
    if (name.value.trim() && name.value.trim() !== pol.name) out.push(`alter policy ${qid(pol.name)} on ${t} rename to ${qid(name.value.trim())};`);
    return out.join("\n");
  };
  const refresh = () => {
    const w = wants();
    usingRow.hidden = !w.using; checkRow.hidden = !w.check;
    const t = tables.find((x) => x.name === table.value);
    rlsRow.hidden = !!pol || !t || t.rls;
    prev.set(sqlText());
  };
  const loadCols = async () => { cols = await columnsOf(schema, table.value); refresh(); };
  tpl.addEventListener("change", () => {
    const x = POLICY_TEMPLATES[tpl.value];
    if (!tpl.value || !x) return;
    if (!pol) cmd.value = x.cmd;
    for (const l of roleBoxes) { const i = l.querySelector("input"); i.checked = x.roles.includes(i.dataset.role); }
    const col = /^[a-z_][a-z0-9_]*$/.test(owner()) ? owner() : qid(owner());
    using.value = x.using.replace(/\{owner\}/g, col);
    check.value = x.check.replace(/\{owner\}/g, col);
    if (!name.value) name.value = x.label;
    refresh();
  });
  for (const el of [name, table, cmd, kind, using, check, enableRls, ...roleBoxes.map((l) => l.querySelector("input"))]) { el.addEventListener("input", refresh); el.addEventListener("change", refresh); }
  table.addEventListener("change", loadCols);
  await loadCols();

  const ok = await dialog(pol ? `Edit policy` : "Create a policy", () => h("div", { class: "stack" },
    pol ? null : formRow("Template", tpl, "Fills in the fields below. Check the expression before you save."),
    formRow("Name", name), formRow("Table", table, pol ? "A policy's table, command and type cannot be changed. Create a new policy instead." : null),
    formRow("Command", cmd), formRow("Type", kind), rlsRow,
    formRow("Roles", h("div", { class: "checks", id: "pol-roles" }, roleBoxes), "service_role bypasses row-level security, so it is not listed."),
    usingRow, checkRow,
    h("div", { class: "form-section" }, h("h3", null, "SQL that will run"), prev.el)), {
    sheet: true, confirmLabel: pol ? "Save policy" : "Create policy",
    onSubmit: async () => {
      if (!name.value.trim()) throw new Error("Give the policy a name.");
      const w = wants();
      if (!roles().length) throw new Error("Choose at least one role.");
      if (w.using) NO_SEMI("The using expression", using.value);
      if (w.check) NO_SEMI("The with check expression", check.value);
      if (cmd.value === "INSERT" && !check.value.trim()) throw new Error("An insert policy needs a with check expression.");
      if (cmd.value !== "INSERT" && !using.value.trim() && !(w.check && check.value.trim())) throw new Error("Write a using expression (for example true, or auth.uid() = user_id).");
      if (pol && cmd.value !== "INSERT" && !using.value.trim()) throw new Error("A using expression is required.");
      await sqlRun(sqlText());
      return true;
    },
  });
  if (ok) { toast(pol ? "Policy saved" : "Policy created", "ok"); reload(); }
}

/** Ask "what can this identity see in this table?" without leaving the policies page. */
async function accessTester(ctx, preset) {
  const tables = await tablesIn("public");
  if (!tables.length) { toast("There are no tables in the public schema yet.", "bad"); return; }
  const table = h("select", { id: "tst-table" }, tables.map((t) => h("option", { value: t.name }, t.name)));
  if (preset) table.value = preset;
  const who = h("select", { id: "tst-who" }, [["anon", "An anonymous visitor"], ["user", "A signed-in user…"]].map(([v, l]) => h("option", { value: v }, l)));
  const q = h("input", { id: "tst-user-search", placeholder: "Search users by email", autocomplete: "off", hidden: true });
  const found = h("div", { class: "checks", id: "tst-user-results" });
  let userId = null;
  const out = h("div", { id: "tst-result" });
  const run = async () => {
    clear(out);
    if (who.value === "user" && !userId) { out.append(h("div", { class: "notice bad" }, "Pick a user first.")); return; }
    out.append(h("p", { class: "muted" }, "Checking…"));
    try {
      const r = await api("POST", `/v1/projects/${S.project.ref}/policy-test`, { table: table.value, as: who.value === "anon" ? { type: "anon" } : { type: "user", userId } });
      clear(out);
      if (!r.allowed) { out.append(h("div", { class: "notice bad", id: "tst-denied" }, `${r.identity} cannot read ${r.table}: ${r.reason}.`)); return; }
      out.append(
        h("div", { class: "notice", id: "tst-summary", "data-visible": String(r.visible), "data-total": String(r.total) }, `${r.identity} can see ${r.visible} of ${r.total} row${r.total === 1 ? "" : "s"} in ${r.table}.`,
          !r.rls ? h("div", { class: "warn" }, "Row-level security is off on this table, so every row is visible.") : r.policies === 0 ? h("div", { class: "warn" }, "Row-level security is on but there are no policies, so no rows are visible.") : null),
        r.sample.length ? h("pre", { class: "sql-preview", id: "tst-sample" }, r.sample.map((x) => JSON.stringify(x)).join("\n")) : null);
    } catch (ex) { clear(out); out.append(h("div", { class: "notice bad" }, ex.message)); }
  };
  who.addEventListener("change", () => { q.hidden = who.value !== "user"; clear(found); userId = null; });
  q.addEventListener("input", async () => {
    clear(found);
    if (q.value.trim().length < 1) return;
    try {
      const users = await api("GET", `/v1/projects/${S.project.ref}/ai/users?q=${encodeURIComponent(q.value.trim())}`);
      for (const u of users) found.append(h("button", { type: "button", class: "small", "data-user": u.email, onclick: () => { userId = u.id; q.value = u.email; clear(found); } }, u.email));
    } catch { /* the list is optional */ }
  });
  await dialog("Test access", () => h("div", { class: "stack" },
    h("p", { class: "muted" }, "Runs a read-only query as the chosen identity, with its real role, so you can see exactly which rows your policies allow. Nothing is changed."),
    formRow("Table", table), formRow("Identity", h("div", { class: "stack" }, who, q, found)),
    h("div", { class: "row" }, h("button", { type: "button", class: "primary", id: "tst-run", onclick: run }, "Run test")), out), { confirmLabel: "Close" });
}

// ---------- triggers ----------
async function triggerSheet(tr, reload, ctx) {
  const schema = tr ? tr.schema : ctx.state.schema;
  const tables = await tablesIn(schema);
  const fns = await catalog(`select n.nspname as schema, p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prorettype = 'trigger'::regtype and p.prokind = 'f'
    and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'realtime', 'auth', 'storage', 'extensions') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1, 2`);
  if (!tables.length) { toast(`There are no tables in schema ${schema} yet.`, "bad"); return; }
  const prev = sqlPreview();
  const bits = tr ? Number(tr.tgtype) : 0;
  const name = h("input", { id: "trg-name", placeholder: "e.g. set_updated_at", autocomplete: "off", value: tr ? tr.name : "" });
  const table = h("select", { id: "trg-table" }, tables.map((t) => h("option", { value: t.name }, t.name)));
  if (tr) table.value = tr.table;
  const timing = h("select", { id: "trg-timing" }, ["BEFORE", "AFTER"].map((x) => h("option", { value: x }, x)));
  timing.value = tr ? ((bits & 2) ? "BEFORE" : "AFTER") : "AFTER";
  const evs = [["INSERT", 4], ["UPDATE", 16], ["DELETE", 8]].map(([e, bit]) => h("label", { class: "check" }, h("input", { type: "checkbox", "data-event": e, checked: tr ? !!(bits & bit) : e === "INSERT" }), e.charAt(0) + e.slice(1).toLowerCase()));
  const orient = h("select", { id: "trg-orient" }, [["ROW", "For each row"], ["STATEMENT", "For each statement"]].map(([v, l]) => h("option", { value: v }, l)));
  orient.value = tr ? ((bits & 1) ? "ROW" : "STATEMENT") : "ROW";
  const fn = h("select", { id: "trg-fn" }, fns.length ? fns.map((f) => h("option", { value: `${f.schema}.${f.name}` }, `${f.schema}.${f.name}()`)) : [h("option", { value: "" }, "No trigger functions yet")]);
  if (tr) fn.value = `${tr.fn_schema}.${tr.fn_name}`;
  const when = h("input", { id: "trg-when", class: "code", placeholder: "e.g. OLD.status IS DISTINCT FROM NEW.status", autocomplete: "off", value: tr?.when_expr || "" });
  const events = () => evs.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.dataset.event);
  const sqlText = () => {
    const [fs, fnn] = (fn.value || "schema.function").split(".");
    const w = when.value.trim() && orient.value === "ROW" ? `\n  when (${when.value.trim()})` : "";
    const create = `create trigger ${qid(name.value || "trigger_name")} ${timing.value.toLowerCase()} ${events().map((e) => e.toLowerCase()).join(" or ") || "insert"}\n  on ${qid(schema)}.${qid(table.value)}\n  for each ${orient.value.toLowerCase()}${w}\n  execute function ${qid(fs)}.${qid(fnn)}();`;
    return tr ? `drop trigger ${qid(tr.name)} on ${qid(schema)}.${qid(tr.table)};\n${create}` : create;
  };
  const refresh = () => prev.set(sqlText());
  for (const el of [name, table, timing, orient, fn, when, ...evs.map((l) => l.querySelector("input"))]) { el.addEventListener("input", refresh); el.addEventListener("change", refresh); }
  refresh();
  const ok = await dialog(tr ? "Edit trigger" : "Create a trigger", () => h("div", { class: "stack" },
    formRow("Name", name), formRow("Table", table), formRow("Timing", timing, "BEFORE can change the row before it is written; AFTER runs once it has been."),
    formRow("Events", h("div", { class: "checks", id: "trg-events" }, evs)), formRow("Orientation", orient),
    formRow("Function", fn, fns.length ? "A function that returns trigger." : "Create a function that returns trigger first (Database → Functions)."),
    formRow("Condition (optional)", when, "Only fire when this is true. Only for row triggers."),
    tr ? h("p", { class: "muted" }, "Saving drops the trigger and creates it again, in one transaction.") : null,
    h("div", { class: "form-section" }, h("h3", null, "SQL that will run"), prev.el)), {
    sheet: true, confirmLabel: tr ? "Save trigger" : "Create trigger",
    onSubmit: async () => {
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name.value.trim())) throw new Error("Give the trigger a name: letters, digits and underscores, not starting with a digit.");
      if (!events().length) throw new Error("Choose at least one event.");
      if (!fn.value) throw new Error("Choose a trigger function.");
      NO_SEMI("The condition", when.value);
      await sqlRun(sqlText());
      return true;
    },
  });
  if (ok) { toast(tr ? "Trigger saved" : "Trigger created", "ok"); reload(); }
}

// ---------- indexes ----------
async function indexSheet(reload, ctx) {
  const schema = ctx.state.schema;
  const tables = await tablesIn(schema);
  if (!tables.length) { toast(`There are no tables in schema ${schema} yet.`, "bad"); return; }
  const prev = sqlPreview();
  const table = h("select", { id: "idx-table" }, tables.map((t) => h("option", { value: t.name }, t.name)));
  const pick = h("select", { id: "idx-add", "aria-label": "Add a column" });
  const chips = h("div", { class: "chips", id: "idx-cols" });
  const method = h("select", { id: "idx-method" }, ["btree", "hash", "gin", "gist", "brin"].map((m) => h("option", { value: m }, m)));
  const unique = h("input", { type: "checkbox", id: "idx-unique" });
  const name = h("input", { id: "idx-name", placeholder: "Leave empty to let Postgres choose", autocomplete: "off" });
  const where = h("input", { id: "idx-where", class: "code", placeholder: "e.g. deleted_at IS NULL", autocomplete: "off" });
  let cols = [], chosen = [];
  const sqlText = () => `create ${unique.checked ? "unique " : ""}index${name.value.trim() ? ` ${qid(name.value.trim())}` : ""} on ${qid(schema)}.${qid(table.value)}\n  using ${method.value} (${chosen.map(qid).join(", ") || "column"})${where.value.trim() ? `\n  where (${where.value.trim()})` : ""};`;
  const drawChips = () => {
    clear(chips);
    chosen.forEach((c, i) => chips.append(h("span", { class: "chip-col", "data-col": c },
      h("span", { class: "mono" }, `${i + 1}. ${c}`),
      h("button", { type: "button", "aria-label": `Move ${c} earlier`, disabled: i === 0, onclick: () => { [chosen[i - 1], chosen[i]] = [chosen[i], chosen[i - 1]]; drawChips(); } }, "◀"),
      h("button", { type: "button", "aria-label": `Move ${c} later`, disabled: i === chosen.length - 1, onclick: () => { [chosen[i + 1], chosen[i]] = [chosen[i], chosen[i + 1]]; drawChips(); } }, "▶"),
      h("button", { type: "button", "aria-label": `Remove ${c}`, onclick: () => { chosen = chosen.filter((x) => x !== c); drawChips(); } }, "✕"))));
    if (!chosen.length) chips.append(h("span", { class: "muted" }, "No columns yet. The order matters for lookups on several columns."));
    clear(pick);
    pick.append(h("option", { value: "" }, "Add a column…"), ...cols.filter((c) => !chosen.includes(c.name)).map((c) => h("option", { value: c.name }, `${c.name} (${c.type})`)));
    prev.set(sqlText());
  };
  const loadCols = async () => { cols = await columnsOf(schema, table.value); chosen = []; drawChips(); };
  pick.addEventListener("change", () => { if (pick.value) { chosen.push(pick.value); drawChips(); } });
  for (const el of [method, unique, name, where]) { el.addEventListener("input", () => prev.set(sqlText())); el.addEventListener("change", () => prev.set(sqlText())); }
  table.addEventListener("change", loadCols);
  await loadCols();
  const ok = await dialog("Create an index", () => h("div", { class: "stack" },
    formRow("Table", table), formRow("Columns", h("div", { class: "stack" }, chips, pick)),
    formRow("Method", method, "btree suits almost everything. gin is for arrays, jsonb and text search; gist for ranges and geometry."),
    formRow("Unique", h("label", { class: "check" }, unique, "Reject duplicate values")), formRow("Name", name),
    formRow("Only rows where (optional)", where, "A partial index covers only the rows that match."),
    h("div", { class: "form-section" }, h("h3", null, "SQL that will run"), prev.el)), {
    sheet: true, confirmLabel: "Create index",
    onSubmit: async () => {
      if (!chosen.length) throw new Error("Choose at least one column.");
      if (name.value.trim() && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name.value.trim())) throw new Error("The name may only use letters, digits and underscores.");
      NO_SEMI("The condition", where.value);
      await sqlRun(sqlText());
      return true;
    },
  });
  if (ok) { toast("Index created", "ok"); reload(); }
}

// ---------- enumerated types ----------
async function enumSheet(reload, ctx) {
  const schema = ctx.state.schema;
  const prev = sqlPreview();
  const name = h("input", { id: "enum-name", placeholder: "e.g. order_status", autocomplete: "off" });
  const vals = h("textarea", { id: "enum-values", rows: 6, class: "code", placeholder: "pending\nshipped\ndelivered", spellcheck: "false" });
  const list = () => vals.value.split("\n").map((x) => x.trim()).filter(Boolean);
  const sqlText = () => `create type ${qid(schema)}.${qid(name.value || "type_name")} as enum (${list().map(qlit).join(", ")});`;
  for (const el of [name, vals]) el.addEventListener("input", () => prev.set(sqlText()));
  prev.set(sqlText());
  const ok = await dialog("Create an enumerated type", () => h("div", { class: "stack" },
    formRow("Name", name), formRow("Values", vals, "One value per line, in the order they should sort. You can add more later but not remove them."),
    h("div", { class: "form-section" }, h("h3", null, "SQL that will run"), prev.el)), {
    sheet: true, confirmLabel: "Create type",
    onSubmit: async () => {
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name.value.trim())) throw new Error("Give the type a name: letters, digits and underscores, not starting with a digit.");
      const v = list();
      if (!v.length) throw new Error("Add at least one value.");
      if (new Set(v).size !== v.length) throw new Error("Values must be different from each other.");
      await sqlRun(sqlText());
      return true;
    },
  });
  if (ok) { toast("Type created", "ok"); reload(); }
}

async function enumValueDialog(en, reload, ctx) {
  const schema = ctx.state.schema;
  const existing = typeof en.values_json === "string" ? JSON.parse(en.values_json) : en.values_json || [];
  const value = h("input", { id: "enum-new-value", autocomplete: "off", placeholder: "new value" });
  const where = h("select", { id: "enum-where" }, [["end", "At the end"], ...existing.flatMap((v) => [[`before:${v}`, `Before ${v}`], [`after:${v}`, `After ${v}`]])].map(([v, l]) => h("option", { value: v }, l)));
  const ok = await dialog(`Add a value to ${en.name}`, () => h("div", { class: "stack" }, h("p", { class: "muted" }, `Current values: ${existing.join(", ")}`), formRow("Value", value), formRow("Position", where)), {
    confirmLabel: "Add value",
    onSubmit: async () => {
      const v = value.value.trim();
      if (!v) throw new Error("Type the new value.");
      if (existing.includes(v)) throw new Error(`${v} is already a value of this type.`);
      const [pos, ref] = where.value === "end" ? [null, null] : where.value.split(/:(.*)/s);
      await sqlRun(`alter type ${qid(schema)}.${qid(en.name)} add value ${qlit(v)}${pos ? ` ${pos} ${qlit(ref)}` : ""}`);
      return true;
    },
  });
  if (ok) { toast("Value added", "ok"); reload(); }
}

// ---------- publications ----------
async function publicationSheet(pub, reload) {
  const tables = await tablesIn("public");
  const have = pub ? new Set((await catalog(`select tablename from pg_publication_tables where pubname = ${pgLit(pub.name)} and schemaname = 'public'`)).map((r) => r.tablename)) : new Set();
  const prev = sqlPreview();
  const name = h("input", { id: "pub-name", placeholder: "e.g. my_publication", autocomplete: "off", value: pub ? pub.name : "" });
  const boxes = tables.map((t) => h("label", { class: "check" }, h("input", { type: "checkbox", "data-table": t.name, checked: have.has(t.name), disabled: !!pub?.all_tables }), h("span", { class: "mono" }, t.name)));
  const evs = [["insert", "ins"], ["update", "upd"], ["delete", "del"], ["truncate", "trunc"]].map(([e, k]) => h("label", { class: "check" }, h("input", { type: "checkbox", "data-event": e, checked: pub ? !!pub[k] : e !== "truncate" }), e.charAt(0).toUpperCase() + e.slice(1)));
  const chosenTables = () => boxes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.dataset.table);
  const chosenEvents = () => evs.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.dataset.event);
  const sqlText = () => {
    const opt = `publish = ${qlit(chosenEvents().join(", "))}`;
    if (!pub) return `create publication ${qid(name.value || "publication_name")}${chosenTables().length ? `\n  for table ${chosenTables().map((t) => `${qid("public")}.${qid(t)}`).join(", ")}` : ""}\n  with (${opt});`;
    const out = [`alter publication ${qid(pub.name)} set (${opt});`];
    if (!pub.all_tables) out.push(chosenTables().length ? `alter publication ${qid(pub.name)} set table ${chosenTables().map((t) => `${qid("public")}.${qid(t)}`).join(", ")};` : `-- no tables: every table is removed from the publication`);
    if (name.value.trim() && name.value.trim() !== pub.name) out.push(`alter publication ${qid(pub.name)} rename to ${qid(name.value.trim())};`);
    return out.join("\n");
  };
  const refresh = () => prev.set(sqlText());
  for (const el of [name, ...boxes.map((l) => l.querySelector("input")), ...evs.map((l) => l.querySelector("input"))]) { el.addEventListener("input", refresh); el.addEventListener("change", refresh); }
  refresh();
  const ok = await dialog(pub ? `Edit ${pub.name}` : "Create a publication", () => h("div", { class: "stack" },
    formRow("Name", name),
    formRow("Events", h("div", { class: "checks", id: "pub-events" }, evs), "Which kinds of change are sent to subscribers."),
    pub?.all_tables ? h("p", { class: "muted" }, "This publication covers all tables. Its tables cannot be changed here.")
      : formRow("Tables", tables.length ? h("div", { class: "checks", id: "pub-tables" }, boxes) : h("p", { class: "muted" }, "No tables in the public schema yet."), "Only the public schema is listed. “All tables” needs a superuser, so it is not offered."),
    h("div", { class: "form-section" }, h("h3", null, "SQL that will run"), prev.el)), {
    sheet: true, confirmLabel: pub ? "Save publication" : "Create publication",
    onSubmit: async () => {
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name.value.trim())) throw new Error("Give the publication a name: letters, digits and underscores, not starting with a digit.");
      if (!chosenEvents().length) throw new Error("Choose at least one event.");
      await sqlRun(sqlText().split("\n").filter((l) => !l.startsWith("--")).join("\n"));
      return true;
    },
  });
  if (ok) { toast(pub ? "Publication saved" : "Publication created", "ok"); reload(); }
}

// ---------- role privileges ----------
const PRIVS = [["select", "SELECT"], ["insert", "INSERT"], ["update", "UPDATE"], ["delete", "DELETE"]];
const PRIV_ROLES = ["anon", "authenticated"];

/** A matrix of what the API's two public roles may do to each table. Saving issues GRANT and REVOKE for what changed. */
async function privilegesSheet(reload) {
  const rows = await catalog(`select c.relname as name, c.relrowsecurity as rls,
      ${PRIV_ROLES.flatMap((r) => PRIVS.map(([k, K]) => `has_table_privilege(${pgLit(r)}, c.oid, ${pgLit(K)}) as "${r}_${k}"`)).join(", ")}
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname`);
  if (!rows.length) { toast("There are no tables in the public schema yet.", "bad"); return; }
  const prev = sqlPreview();
  const key = (t, r, k) => `${t}|${r}|${k}`;
  const was = new Map(); const now = new Map();
  for (const t of rows) for (const r of PRIV_ROLES) for (const [k] of PRIVS) { const v = !!t[`${r}_${k}`]; was.set(key(t.name, r, k), v); now.set(key(t.name, r, k), v); }
  const changes = () => {
    const out = [];
    for (const t of rows) for (const r of PRIV_ROLES) {
      const add = PRIVS.filter(([k]) => now.get(key(t.name, r, k)) && !was.get(key(t.name, r, k))).map(([, K]) => K);
      const drop = PRIVS.filter(([k]) => !now.get(key(t.name, r, k)) && was.get(key(t.name, r, k))).map(([, K]) => K);
      if (add.length) out.push(`grant ${add.join(", ")} on ${qid("public")}.${qid(t.name)} to ${r};`);
      if (drop.length) out.push(`revoke ${drop.join(", ")} on ${qid("public")}.${qid(t.name)} from ${r};`);
    }
    return out;
  };
  const refresh = () => prev.set(changes().join("\n") || "-- nothing changed yet");
  const grid = h("div", { class: "tablewrap" }, h("table", { class: "data", id: "priv-table" },
    h("thead", null, h("tr", null, h("th", null, "Table"), h("th", null, "Row security"), PRIV_ROLES.map((r) => h("th", { colspan: 4 }, r)))),
    h("thead", null, h("tr", { class: "subhead" }, h("th"), h("th"), PRIV_ROLES.flatMap(() => PRIVS.map(([, K]) => h("th", null, K.slice(0, 3)))))),
    h("tbody", null, rows.map((t) => h("tr", { "data-row": t.name },
      h("td", null, t.name), h("td", null, t.rls ? "on" : h("span", { class: "warn", title: "Anyone with a grant can read or change every row" }, "off")),
      PRIV_ROLES.flatMap((r) => PRIVS.map(([k, K]) => h("td", null, h("input", { type: "checkbox", "aria-label": `${r} ${K} on ${t.name}`, "data-cell": key(t.name, r, k), checked: now.get(key(t.name, r, k)),
        onchange: (e) => { now.set(key(t.name, r, k), e.target.checked); refresh(); } })))))))));
  refresh();
  const ok = await dialog("Table privileges", () => h("div", { class: "stack" },
    h("p", { class: "muted" }, "What the anon (not signed in) and authenticated (signed in) roles may do to each table. A grant lets the role try; row-level security decides which rows it may touch. Tables with security off expose every row to anyone with a grant."),
    grid, h("div", { class: "form-section" }, h("h3", null, "SQL that will run"), prev.el)), {
    sheet: true, confirmLabel: "Apply changes",
    onSubmit: async () => { const c = changes(); if (!c.length) throw new Error("Nothing has changed."); await sqlRun(c.join("\n")); return true; },
  });
  if (ok) { toast("Privileges updated", "ok"); reload(); }
}

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
    title: "Triggers", hint: "Functions that run automatically when rows change. Triggers the platform installs for Realtime and Pipelines are not listed.", searchPlaceholder: "Search for a trigger", empty: "No triggers in this schema.",
    toolbarAction: (reload, ctx) => h("button", { class: "primary", id: "new-trigger", onclick: () => triggerSheet(null, reload, ctx) }, icon("plus", 15), " New trigger"),
    query: (s) => `select t.tgname as name, c.relname as "table", p.proname as function, fn.nspname as fn_schema, p.proname as fn_name, n.nspname as schema, t.tgtype::int as tgtype,
        pg_get_expr(t.tgqual, t.tgrelid) as when_expr, pg_get_triggerdef(t.oid) as definition, t.tgenabled <> 'D' as enabled
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid join pg_namespace fn on fn.oid = p.pronamespace
      where not t.tgisinternal and t.tgname <> 'baas_realtime' and n.nspname = ${pgLit(s)} order by c.relname, t.tgname`,
    cols: [{ label: "Name", cell: (r, reload, ctx) => h("button", { class: "linkish", "data-action": "open-trigger", onclick: () => triggerSheet(r, reload, ctx) }, r.name) },
      { key: "table", label: "Table" }, { key: "function", label: "Function" },
      { label: "Events", cell: (r) => (/(?:BEFORE|AFTER|INSTEAD OF) ([A-Z ]+?) ON /.exec(r.definition)?.[1] || "").replace(/ OR /g, ", ") }, { label: "Enabled", cell: (r) => (r.enabled ? "yes" : "no") }],
    actions: (r, reload, ctx) => [rowMenu([
      ["Edit trigger", () => triggerSheet(r, reload, ctx), { action: "edit-trigger" }],
      [r.enabled ? "Disable" : "Enable", async () => { try { await sqlRun(`alter table ${qid(r.schema)}.${qid(r.table)} ${r.enabled ? "disable" : "enable"} trigger ${qid(r.name)}`); toast(r.enabled ? "Trigger disabled" : "Trigger enabled", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); } }, { action: "toggle-trigger" }],
      ["View definition", () => definitionDialog(`Trigger ${r.name}`, r.definition), { action: "definition" }],
      ["Delete trigger", async () => {
        if (!(await confirmBox("Delete trigger", `Delete “${r.name}” on ${r.table}?`, { typed: r.name, confirmLabel: "Delete trigger" }))) return;
        try { await sqlRun(`drop trigger ${qid(r.name)} on ${qid(r.schema)}.${qid(r.table)}`); toast("Trigger deleted", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); }
      }, { danger: true, action: "drop-trigger" }],
    ])],
  },
  enums: {
    title: "Enumerated Types", hint: "Custom types with a fixed list of values. You can add values later but not remove them.", searchPlaceholder: "Search for a type", empty: "No enumerated types in this schema.",
    toolbarAction: (reload, ctx) => h("button", { class: "primary", id: "new-enum", onclick: () => enumSheet(reload, ctx) }, icon("plus", 15), " New type"),
    query: (s) => `select t.typname as name, (select string_agg(e.enumlabel, ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as "values",
        (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as values_json
      from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype = 'e' and n.nspname = ${pgLit(s)} order by t.typname`,
    cols: [{ key: "name", label: "Name" }, { key: "values", label: "Values", max: 120 }],
    actions: (r, reload, ctx) => [rowMenu([
      ["Add a value", () => enumValueDialog(r, reload, ctx), { action: "add-enum-value" }],
      ["Delete type", async () => {
        if (!(await confirmBox("Delete type", `Delete the type ${r.name}? This fails if a column still uses it.`, { typed: r.name, confirmLabel: "Delete type" }))) return;
        try { await sqlRun(`drop type ${qid(ctx.state.schema)}.${qid(r.name)}`); toast("Type deleted", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); }
      }, { danger: true, action: "drop-enum" }],
    ])],
  },
  extensions: {
    schemas: false, title: "Extensions", hint: "PostgreSQL extensions installed in this database. Installing more is done by whoever runs the server.", searchPlaceholder: "Search for an extension", empty: "No extensions.",
    query: () => `select e.name, e.default_version as version, e.installed_version, e.comment from pg_available_extensions e order by (e.installed_version is null), e.name`,
    cols: [{ key: "name", label: "Name" }, { label: "Status", cell: (r) => (r.installed_version ? h("span", { class: "ok" }, `enabled ${r.installed_version}`) : h("span", { class: "muted" }, "available")) }, { key: "comment", label: "Description", max: 90 }],
  },
  indexes: {
    title: "Indexes", hint: "Indexes speed up lookups. Indexes that enforce a primary key or unique constraint are managed with the table.", searchPlaceholder: "Search for an index", empty: "No indexes in this schema.",
    toolbarAction: (reload, ctx) => h("button", { class: "primary", id: "new-index", onclick: () => indexSheet(reload, ctx) }, icon("plus", 15), " New index"),
    query: (s) => `select ic.relname as name, tc.relname as "table", pg_get_indexdef(i.indexrelid) as definition, pg_size_pretty(pg_relation_size(i.indexrelid)) as size, am.amname as method,
        exists(select 1 from pg_constraint k where k.conindid = i.indexrelid) as backs_constraint, n.nspname as schema
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class tc on tc.oid = i.indrelid join pg_namespace n on n.oid = tc.relnamespace join pg_am am on am.oid = ic.relam
      where n.nspname = ${pgLit(s)} order by tc.relname, ic.relname`,
    cols: [{ key: "name", label: "Name" }, { key: "table", label: "Table" }, { key: "method", label: "Method" }, { key: "definition", label: "Definition", mono: true, max: 90 }, { key: "size", label: "Size" }],
    actions: (r, reload) => [rowMenu([
      ["View definition", () => definitionDialog(`Index ${r.name}`, r.definition), { action: "definition" }],
      ["Delete index", async () => {
        if (!(await confirmBox("Delete index", `Delete the index ${r.name}? Queries that relied on it may get slower.`, { typed: r.name, confirmLabel: "Delete index" }))) return;
        try { await sqlRun(`drop index ${qid(r.schema)}.${qid(r.name)}`); toast("Index deleted", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); }
      }, { danger: true, action: "drop-index", disabled: r.backs_constraint, why: r.backs_constraint ? "This index enforces a constraint; change the constraint instead" : "" }],
    ])],
  },
  policies: {
    title: "Policies", hint: "Row-level security policies decide which rows each role can read or change. Tables with security on and no policy hide every row.", searchPlaceholder: "Search for a policy", empty: "No policies in this schema.",
    toolbarAction: (reload, ctx) => h("span", { class: "row" },
      h("button", { id: "test-access", onclick: () => accessTester(ctx) }, "Test access"),
      h("button", { class: "primary", id: "new-policy", onclick: () => policySheet(null, reload, ctx) }, icon("plus", 15), " New policy")),
    query: (s) => `select p.policyname as name, p.tablename as "table", p.cmd as command, array_to_string(p.roles, ', ') as roles, p.permissive, p.qual as "using", p.with_check as "check", p.schemaname as schema
      from pg_policies p where p.schemaname = ${pgLit(s)} order by p.tablename, p.policyname`,
    cols: [{ label: "Name", cell: (r, reload, ctx) => h("button", { class: "linkish", "data-action": "open-policy", onclick: () => policySheet(r, reload, ctx) }, r.name) },
      { key: "table", label: "Table" }, { key: "command", label: "Command" }, { key: "roles", label: "Roles" }, { key: "using", label: "Using", mono: true, max: 60 }, { key: "check", label: "With check", mono: true, max: 60 }],
    actions: (r, reload, ctx) => [rowMenu([
      ["Edit policy", () => policySheet(r, reload, ctx), { action: "edit-policy" }],
      ["Test access to this table", () => accessTester(ctx, r.table), { action: "test-policy" }],
      ["View definition", () => definitionDialog(`Policy ${r.name}`, `create policy ${qid(r.name)} on ${qid(r.schema)}.${qid(r.table)}\n  as ${r.permissive.toLowerCase()} for ${r.command.toLowerCase()} to ${r.roles}${r.using ? `\n  using (${r.using})` : ""}${r.check ? `\n  with check (${r.check})` : ""};`), { action: "definition" }],
      ["Delete policy", async () => {
        if (!(await confirmBox("Delete policy", `Delete “${r.name}” on ${r.table}? Access changes immediately.`, { confirmLabel: "Delete policy" }))) return;
        try { await sqlRun(`drop policy ${qid(r.name)} on ${qid(r.schema)}.${qid(r.table)}`); toast("Policy deleted", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); }
      }, { danger: true, action: "drop-policy" }],
    ])],
  },
  roles: {
    schemas: false, title: "Roles", hint: "The database roles your API uses. Their privileges are granted per table; row-level security narrows them further.", searchPlaceholder: "Search for a role", empty: "No roles.",
    toolbarAction: (reload) => h("button", { id: "edit-privileges", onclick: () => privilegesSheet(reload) }, "Table privileges"),
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
    docs: "https://www.postgresql.org/docs/current/sql-createfunction.html",
    toolbarAction: (reload, ctx) => h("span", { class: "row" },
      h("button", { class: "primary", id: "new-function", onclick: () => functionSheet(null, reload, ctx) }, icon("plus", 15), " New function"),
      h("button", { class: "iconbtn", id: "fn-ai", title: "Describe the function to the AI assistant", "aria-label": "Create with AI", onclick: () => { sessionStorage.setItem("baas.ai.prefill", `Create a new function for the schema ${ctx.state.schema} that does `); location.hash = `#/p/${S.project.ref}/ai`; } }, icon("sparkles", 15))),
    filters: [
      { id: "return", label: "Return Type", values: (rows) => [...new Set(rows.map((r) => r.return_type).filter(Boolean))].sort(), test: (r, v) => r.return_type === v },
      { id: "security", label: "Security", values: () => ["Definer", "Invoker"], test: (r, v) => (r.security_definer ? "Definer" : "Invoker") === v },
    ],
    query: (s) => `select p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments, pg_get_function_arguments(p.oid) as arguments_full, pg_get_function_result(p.oid) as return_type, l.lanname as language,
      p.prosecdef as security_definer, p.prosrc as body, p.provolatile as volatility, p.proargmodes is null as plain_args, pg_get_functiondef(p.oid) as definition, n.nspname as schema,
      (select coalesce(json_agg(json_build_object('name', u.nm, 'type', format_type(u.t, null)) order by u.ord), '[]'::json)
         from unnest(coalesce(p.proargnames, array_fill(''::text, array[p.pronargs::int])), string_to_array(p.proargtypes::text, ' ')::oid[]) with ordinality as u(nm, t, ord)) as arg_list
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
      where n.nspname = ${pgLit(s)} and p.prokind = 'f' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by p.proname, p.oid`,
    cols: [{ label: "Name", cell: (r, reload, ctx) => h("button", { class: "linkish", title: `Edit ${r.name}`, "data-action": "open-function", onclick: () => functionSheet(r, reload, ctx) }, r.name) },
      { label: "Type", cell: () => "Function" },
      { label: "Arguments", mono: true, max: 40, cell: (r) => r.arguments || "–" },
      { label: "Return type", mono: true, max: 40, cell: (r) => (r.return_type === "trigger" ? h("a", { href: `#/p/${S.project.ref}/database/triggers` }, "trigger") : r.return_type || "–") },
      { label: "Security", cell: (r) => (r.security_definer ? h("span", { title: "Runs with its owner's privileges" }, "Definer") : "Invoker") }],
    actions: (r, reload, ctx) => [rowMenu([
      ["Edit function", () => functionSheet(r, reload, ctx), { action: "edit-function" }],
      ["Delete function", async () => {
        if (!(await confirmBox("Delete function", `Delete ${r.schema}.${r.name}(${r.arguments})? Anything that calls it will fail.`, { typed: r.name, confirmLabel: "Delete function" }))) return;
        try { await sqlRun(`drop function ${JSON.stringify(r.schema)}.${JSON.stringify(r.name)}(${r.arguments})`); toast("Function deleted", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); }
      }, { danger: true, action: "drop-function" }],
    ])],
  },
  publications: {
    schemas: false, title: "Publications", hint: "Publications choose which tables stream their changes to subscribers, such as logical replication clients.", searchPlaceholder: "Search for a publication", empty: "No publications.",
    toolbarAction: (reload) => h("button", { class: "primary", id: "new-publication", onclick: () => publicationSheet(null, reload) }, icon("plus", 15), " New publication"),
    query: () => `select p.pubname as name, p.puballtables as all_tables, p.pubinsert as ins, p.pubupdate as upd, p.pubdelete as del, p.pubtruncate as trunc,
      (select count(*) from pg_publication_tables t where t.pubname = p.pubname) as tables from pg_publication p order by p.pubname`,
    cols: [{ key: "name", label: "Name" }, { label: "Insert", cell: (r) => (r.ins ? "yes" : "no") }, { label: "Update", cell: (r) => (r.upd ? "yes" : "no") }, { label: "Delete", cell: (r) => (r.del ? "yes" : "no") },
      { label: "Truncate", cell: (r) => (r.trunc ? "yes" : "no") }, { label: "Source", cell: (r) => (r.all_tables ? "All tables" : `${r.tables} table${Number(r.tables) === 1 ? "" : "s"}`) }],
    actions: (r, reload) => [rowMenu([
      ["Edit publication", () => publicationSheet(r, reload), { action: "edit-publication" }],
      ["Delete publication", async () => {
        if (!(await confirmBox("Delete publication", `Delete “${r.name}”? Subscribers using it stop receiving changes.`, { typed: r.name, confirmLabel: "Delete publication" }))) return;
        try { await sqlRun(`drop publication ${qid(r.name)}`); toast("Publication deleted", "ok"); reload(); } catch (ex) { toast(ex.message, "bad"); }
      }, { danger: true, action: "drop-publication" }],
    ])],
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

const SIMPLE_TYPES = ["void", "text", "integer", "bigint", "boolean", "uuid", "jsonb", "json", "numeric", "timestamptz", "date", "trigger", "record", "setof record"];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPE_TEXT = /^[\w\s.\[\]()",]+$/;

/** The right-hand "Add a new function" panel. Editing fills the same form from the catalog; unusual functions fall back to raw SQL. */
/** A textarea with a line-number gutter that scrolls with it. */
function lineNumbered(area) {
  const gutter = h("pre", { class: "gutter", "aria-hidden": "true" });
  const draw = () => { const n = area.value.split("\n").length; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n"); gutter.scrollTop = area.scrollTop; };
  area.addEventListener("input", draw); area.addEventListener("scroll", () => { gutter.scrollTop = area.scrollTop; });
  area.setAttribute("wrap", "off");
  draw();
  return h("div", { class: "code-wrap" }, gutter, area);
}

async function functionSheet(fn, reload, ctx) {
  if (fn && (!fn.plain_args || /\bdefault\b/i.test(fn.arguments_full || "") || !["sql", "plpgsql"].includes(fn.language) || /^table\(/i.test(fn.return_type || ""))) return functionDialog(fn, reload);
  let list = [];
  if (fn) { try { list = typeof fn.arg_list === "string" ? JSON.parse(fn.arg_list) : fn.arg_list || []; } catch { return functionDialog(fn, reload); } }
  const schemaSel = h("select", { id: "fn-schema", name: "schema", disabled: !!fn }, ctx.schemas.map((x) => h("option", { value: x }, `schema ${x}`)));
  schemaSel.value = fn ? fn.schema : ctx.state.schema;
  const name = h("input", { id: "fn-name", name: "name", placeholder: "Name of function", autocomplete: "off", readOnly: !!fn, value: fn ? fn.name : "" });
  const ret = h("input", { id: "fn-return", name: "ret", list: "fn-types", autocomplete: "off", value: fn ? fn.return_type : "void" });
  const types = h("datalist", { id: "fn-types" }, SIMPLE_TYPES.map((t) => h("option", { value: t })));
  const argBox = h("div", { class: "args", id: "fn-args" });
  const addArg = (a = { name: "", type: "" }) => {
    const row = h("div", { class: "arg-row", "data-arg": "1" },
      h("input", { placeholder: "name", "aria-label": "Argument name", "data-arg-name": "1", value: a.name, autocomplete: "off" }),
      h("input", { placeholder: "type", "aria-label": "Argument type", "data-arg-type": "1", list: "fn-types", value: a.type, autocomplete: "off" }),
      h("button", { type: "button", class: "iconbtn", "aria-label": "Remove argument", onclick: () => row.remove() }, icon("x", 15)));
    argBox.append(row);
  };
  list.forEach(addArg);
  const lang = h("select", { id: "fn-language" }, ["plpgsql", "sql"].map((l) => h("option", { value: l }, l)));
  lang.value = fn ? fn.language : "plpgsql";
  const vol = h("select", { id: "fn-volatility" }, ["VOLATILE", "STABLE", "IMMUTABLE"].map((v) => h("option", { value: v }, v)));
  vol.value = fn ? ({ v: "VOLATILE", s: "STABLE", i: "IMMUTABLE" }[fn.volatility] || "VOLATILE") : "VOLATILE";
  const sec = h("select", { id: "fn-security" }, [["invoker", "SECURITY INVOKER"], ["definer", "SECURITY DEFINER"]].map(([v, l]) => h("option", { value: v }, l)));
  sec.value = fn && fn.security_definer ? "definer" : "invoker";
  const body = h("textarea", { class: "code editor", id: "fn-body", rows: 12, spellcheck: "false" }, fn ? fn.body.replace(/^\n|\n$/g, "") : "BEGIN\n  \nEND;");
  const field = (label, el, hint) => h("div", { class: "form-row" }, h("label", { for: el.id }, label), h("div", null, el, hint ? h("p", { class: "muted hint" }, hint) : null));
  const ok = await dialog(fn ? `Edit ${fn.name}` : "Add a new function", () => h("div", { class: "stack" },
    field("Schema", schemaSel, "Tables made in the table editor will be in public"),
    field("Name of function", name, "Name will also be used for the function name in postgres"),
    field("Type", h("select", { id: "fn-type", disabled: true }, h("option", null, "Function"))),
    field("Return type", ret, "void returns nothing; setof … returns several rows; trigger is for trigger functions"), types,
    h("div", { class: "form-section" }, h("h3", null, "Arguments"), h("p", { class: "muted" }, "Arguments can be referenced in the function body using either names or numbers."),
      argBox, h("button", { type: "button", id: "add-arg", onclick: () => addArg() }, icon("plus", 14), " Add a new argument")),
    h("div", { class: "form-section" }, h("h3", null, "Definition"), h("p", { class: "muted" }, "The language below should be written in ", h("code", null, "plpgsql"), ". Change the language in the advanced settings."), lineNumbered(body)),
    h("details", { class: "form-section", id: "fn-advanced" }, h("summary", null, "Advanced settings"),
      h("div", { class: "stack" }, field("Language", lang), field("Behavior", vol), field("Type of security", sec,
        "Definer runs with the owner's privileges, which bypasses row-level security. Use it carefully and check who may call it."))),
    fn && h("p", { class: "muted" }, "Changing an argument's type creates an overload; the old one stays until you delete it.")), {
    sheet: true, confirmLabel: fn ? "Save function" : "Create function",
    onSubmit: async () => {
      if (!IDENT.test(name.value)) throw new Error("Give the function a name: letters, digits and underscores, not starting with a digit.");
      const args = [...argBox.querySelectorAll("[data-arg]")].map((row) => {
        const n = row.querySelector("[data-arg-name]").value.trim(), t = row.querySelector("[data-arg-type]").value.trim();
        if (n && !IDENT.test(n)) throw new Error(`"${n}" is not a valid argument name.`);
        if (!t || !TYPE_TEXT.test(t)) throw new Error(`Argument ${n || "(unnamed)"} needs a valid type.`);
        return `${n ? `${JSON.stringify(n)} ` : ""}${t}`;
      });
      const r = ret.value.trim();
      if (!r || !TYPE_TEXT.test(r)) throw new Error("Choose a return type.");
      let tag = "$fn$", i = 1;
      while (body.value.includes(tag)) tag = `$fn${i++}$`;
      const defn = sec.value === "definer" ? " security definer" : "";
      await sqlRun(`create or replace function ${JSON.stringify(schemaSel.value)}.${JSON.stringify(name.value)}(${args.join(", ")}) returns ${r} language ${lang.value} ${vol.value.toLowerCase()}${defn} as ${tag}\n${body.value}\n${tag};`);
      return true;
    },
  });
  if (ok) { toast(fn ? "Function saved" : "Function created", "ok"); reload(); }
}

/** Every table in a schema as a draggable card of its columns, with a line for each foreign key. */
async function schemaVisualizer(body, p) {
  const W = 280, HEAD = 34, ROW = 29;
  const schemas = (await catalog(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by (nspname = 'public') desc, nspname`)).map((r) => r.nspname);
  let schema = "public", tables = [], byName = new Map(), pos = {}, find = "", scale = 1;
  const stage = h("div", { class: "schema-stage" });
  const sizer = h("div", { class: "schema-sizer" }, stage);
  const canvas = h("div", { class: "schema-canvas", id: "schema-canvas" }, sizer);
  const svg = svgEl("svg", { class: "rel-lines", id: "rel-lines" });
  const zoomLabel = h("span", { class: "zoom-label", id: "zoom-label" }, "100%");
  const storeKey = () => `baas.schema.${p.ref}.${schema}`;
  const save = () => { try { localStorage.setItem(storeKey(), JSON.stringify(pos)); } catch { /* private mode */ } };
  const cardH = (t) => HEAD + t.cols.length * ROW + 2;

  const load = async () => {
    const rows = await catalog(`select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, a.attidentity <> '' as ident,
      c.relrowsecurity as rls, c.reltuples::bigint as est,
      exists(select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p' and a.attnum = any(k.conkey)) as pk,
      exists(select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'u' and k.conkey = array[a.attnum]) as uniq,
      (select cf.relname from pg_constraint k join pg_class cf on cf.oid = k.confrelid where k.conrelid = c.oid and k.contype = 'f' and k.conkey[1] = a.attnum limit 1) as fk_table,
      (select af.attname from pg_constraint k join pg_attribute af on af.attrelid = k.confrelid and af.attnum = k.confkey[1] where k.conrelid = c.oid and k.contype = 'f' and k.conkey[1] = a.attnum limit 1) as fk_col
      from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = ${pgLit(schema)} and c.relkind in ('r', 'p') order by c.relname, a.attnum`);
    const map = new Map();
    for (const r of rows) { if (!map.has(r.tbl)) map.set(r.tbl, []); map.get(r.tbl).push(r); }
    tables = [...map].map(([name, cols]) => ({ name, cols, rls: cols[0].rls, est: Number(cols[0].est) }));
    byName = new Map(tables.map((t) => [t.name, t]));
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storeKey()) || "{}"); } catch { /* ignore */ }
    pos = {};
    if (tables.every((t) => saved[t.name])) pos = saved; else autoLayout(false);
    draw();
  };

  /** Referenced tables go left, the tables that point at them go right; long columns wrap. */
  function autoLayout(redraw = true) {
    const depth = new Map(tables.map((t) => [t.name, 0]));
    for (let pass = 0; pass < tables.length; pass++) {
      let changed = false;
      for (const t of tables) for (const c of t.cols) {
        if (c.fk_table && c.fk_table !== t.name && byName.has(c.fk_table) && depth.get(c.fk_table) + 1 > depth.get(t.name) && depth.get(c.fk_table) + 1 <= tables.length) { depth.set(t.name, depth.get(c.fk_table) + 1); changed = true; }
      }
      if (!changed) break;
    }
    pos = {};
    let col = 0;
    const maxDepth = Math.max(0, ...depth.values());
    for (let d = 0; d <= maxDepth; d++) {
      const group = tables.filter((t) => depth.get(t.name) === d);
      for (let k = 0; k < group.length; k += 8) {
        let y = 24;
        for (const t of group.slice(k, k + 8)) { pos[t.name] = { x: 24 + col * (W + 90), y }; y += cardH(t) + 30; }
        col++;
      }
    }
    save();
    if (redraw) draw();
  }

  const marker = (c) => (c.pk ? h("span", { class: "mk pk", title: "Primary key" }, icon("key", 12)) : c.ident ? h("span", { class: "mk", title: "Identity" }, "#") : c.uniq ? h("span", { class: "mk", title: "Unique" }, "≡") : h("span", { class: `mk ${c.notnull ? "nn" : "nl"}`, title: c.notnull ? "Non-nullable" : "Nullable" }, c.notnull ? "◆" : "◇"));
  const ddlFor = (t) => `create table ${JSON.stringify(schema)}.${JSON.stringify(t.name)} (\n${[...t.cols.map((c) => `  ${JSON.stringify(c.col)} ${c.type}${c.notnull ? " not null" : ""}`), ...(t.cols.some((c) => c.pk) ? [`  primary key (${t.cols.filter((c) => c.pk).map((c) => JSON.stringify(c.col)).join(", ")})`] : []), ...t.cols.filter((c) => c.fk_table).map((c) => `  foreign key (${JSON.stringify(c.col)}) references ${JSON.stringify(schema)}.${JSON.stringify(c.fk_table)} (${JSON.stringify(c.fk_col)})`)].join(",\n")}\n);`;
  const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg, "ok"); } catch { openInSql(text); } };
  const matches = (t) => !find || t.name.toLowerCase().includes(find.toLowerCase());

  function resize() {
    let bw = 400, bh = 300;
    for (const t of tables) { const q = pos[t.name]; bw = Math.max(bw, q.x + W + 40); bh = Math.max(bh, q.y + cardH(t) + 40); }
    stage.style.width = `${bw}px`; stage.style.height = `${bh}px`;
    stage.style.transform = `scale(${scale})`;
    sizer.style.width = `${bw * scale}px`; sizer.style.height = `${bh * scale}px`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    svg.setAttribute("width", bw); svg.setAttribute("height", bh);
  }

  function drawLines() {
    clear(svg);
    for (const t of tables) t.cols.forEach((c, ci) => {
      const target = c.fk_table && byName.get(c.fk_table);
      if (!target) return;
      const a = pos[t.name], b = pos[target.name];
      const ri = Math.max(0, target.cols.findIndex((x) => x.col === c.fk_col));
      const y1 = a.y + HEAD + ci * ROW + ROW / 2 + 1, y2 = b.y + HEAD + ri * ROW + ROW / 2 + 1;
      let x1, x2, d1, d2;
      if (a.x + W + 20 <= b.x) { x1 = a.x + W; x2 = b.x; d1 = 1; d2 = -1; }
      else if (b.x + W + 20 <= a.x) { x1 = a.x; x2 = b.x + W; d1 = -1; d2 = 1; }
      else { x1 = a.x + W; x2 = b.x + W; d1 = 1; d2 = 1; }
      const k = d1 === d2 ? 50 : Math.max(40, Math.abs(x2 - x1) / 2);
      const dim = find && !matches(t) && !matches(target);
      const rel = `${t.name}.${c.col}>${target.name}.${c.fk_col}`;
      const g = svgEl("g", { class: `rel ${dim ? "dim" : ""}`, "data-rel": rel });
      g.append(svgEl("title", {}), svgEl("path", { d: `M${x1},${y1} C${x1 + d1 * k},${y1} ${x2 + d2 * k},${y2} ${x2},${y2}` }),
        svgEl("circle", { cx: x1, cy: y1, r: 3.5, class: "from" }), svgEl("circle", { cx: x2, cy: y2, r: 3.5, class: "to" }));
      g.firstChild.textContent = `${t.name}.${c.col} references ${target.name}.${c.fk_col}`;
      svg.append(g);
    });
  }

  function draw() {
    clear(stage);
    stage.append(svg);
    if (!tables.length) { stage.append(h("div", { class: "empty schema-empty" }, "No tables in this schema.")); resize(); return; }
    for (const t of tables) {
      const q = pos[t.name];
      const head = h("div", { class: "st-head", title: "Drag to move" }, icon("table", 14), h("strong", null, t.name),
        h("span", { class: "st-info", title: `${t.rls ? "Row-level security on" : "Row-level security off"} · about ${Math.max(0, t.est).toLocaleString()} rows` }, "ⓘ"),
        rowMenu([
          ["View in table editor", () => { TSTATE = { table: t.name, offset: 0, limit: 50 }; location.hash = `#/p/${p.ref}/tables`; }, { action: "view-table" }],
          ["Copy table as SQL", () => copy(ddlFor(t), "SQL copied")],
          ["Copy name", () => copy(t.name, "Name copied")],
        ]));
      const card = h("div", { class: `schema-table ${matches(t) ? "" : "dim"}`, "data-table": t.name }, head,
        t.cols.map((c) => h("div", { class: "st-col", "data-col": c.col, title: c.fk_table ? `References ${c.fk_table}.${c.fk_col}` : "" }, marker(c), h("span", { class: "st-name" }, c.col), h("span", { class: "st-type" }, c.type))));
      card.style.left = `${q.x}px`; card.style.top = `${q.y}px`;
      head.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        const sx = e.clientX, sy = e.clientY, o = { ...pos[t.name] };
        head.setPointerCapture(e.pointerId);
        const move = (ev) => {
          pos[t.name] = { x: Math.max(0, Math.round(o.x + (ev.clientX - sx) / scale)), y: Math.max(0, Math.round(o.y + (ev.clientY - sy) / scale)) };
          card.style.left = `${pos[t.name].x}px`; card.style.top = `${pos[t.name].y}px`;
          drawLines();
        };
        const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); save(); resize(); };
        head.addEventListener("pointermove", move); head.addEventListener("pointerup", up);
      });
      stage.append(card);
    }
    drawLines(); resize();
  }

  const zoomTo = (v) => { scale = Math.min(1.5, Math.max(0.3, Math.round(v * 100) / 100)); resize(); };
  const fit = () => {
    const bw = Math.max(...tables.map((t) => pos[t.name].x + W + 40), 400);
    zoomTo(Math.min(1, (canvas.clientWidth - 8) / bw));
    canvas.scrollTo({ left: 0, top: 0 });
  };
  const schemaSel = h("select", { id: "schema-schema", "aria-label": "Schema", onchange: (e) => { schema = e.target.value; load(); } }, schemas.map((x) => h("option", { value: x }, `schema ${x}`)));
  const copyMenu = (e) => {
    e.stopPropagation();
    const open = document.querySelector(".menu.row-menu"); closeMenus(); if (open) return;
    const box = e.currentTarget.getBoundingClientRect();
    const menu = h("div", { class: "menu row-menu", role: "menu" },
      h("button", { role: "menuitem", onclick: () => { closeMenus(); copy(tables.map(ddlFor).join("\n\n"), "SQL copied"); } }, "Copy as SQL"),
      h("button", { role: "menuitem", onclick: () => { closeMenus(); copy(JSON.stringify({ schema, tables: tables.map((t) => ({ name: t.name, columns: t.cols.map((c) => ({ name: c.col, type: c.type, notNull: c.notnull, primaryKey: c.pk, references: c.fk_table ? `${c.fk_table}.${c.fk_col}` : null })) })) }, null, 2), "JSON copied"); } }, "Copy as JSON"));
    menu.style.position = "fixed"; menu.style.top = `${Math.round(box.bottom + 4)}px`; menu.style.right = `${Math.round(window.innerWidth - box.right)}px`;
    document.body.append(menu);
  };
  const legend = [["key", "Primary key"], ["#", "Identity"], ["≡", "Unique"], ["◇", "Nullable"], ["◆", "Non-Nullable"]];
  clear(body);
  body.append(h("div", { class: "schema-page" },
    h("div", { class: "toolbar" }, schemaSel,
      h("input", { id: "schema-find", placeholder: "Find table...", "aria-label": "Find table", oninput: (e) => {
        find = e.target.value; draw();
        const first = tables.find(matches);
        if (find && first) canvas.scrollTo({ left: Math.max(0, pos[first.name].x * scale - 20), top: Math.max(0, pos[first.name].y * scale - 20), behavior: "smooth" });
      } }),
      h("span", { class: "spacer" }),
      h("div", { class: "zoom" }, h("button", { id: "zoom-out", "aria-label": "Zoom out", onclick: () => zoomTo(scale - 0.1) }, "−"), zoomLabel,
        h("button", { id: "zoom-in", "aria-label": "Zoom in", onclick: () => zoomTo(scale + 0.1) }, "+"), h("button", { id: "zoom-fit", onclick: fit }, "Fit")),
      h("div", { class: "splitbtn" },
        h("button", { id: "copy-sql", onclick: () => copy(tables.map(ddlFor).join("\n\n"), "SQL copied") }, icon("copy", 14), " Copy as SQL"),
        h("button", { id: "copy-more", "aria-label": "More copy options", onclick: copyMenu }, icon("chevrons", 13))),
      h("button", { id: "auto-layout", onclick: () => { autoLayout(); toast("Layout reset", "ok"); } }, "Auto layout")),
    canvas,
    h("div", { class: "legend" }, legend.map(([m, t]) => h("span", null, m === "key" ? icon("key", 13) : h("b", null, m), " ", t)), h("span", { class: "hint" }, "Drag a table by its title to move it."))));
  await load();
}

async function dbPage(body, p, page) {
  if (page === "backups") { await backups(body, p); return; }
  if (page === "schema") { await schemaVisualizer(body, p); return; }
  if (page === "pipelines") { await pipelinesPage(body, p); return; }
  await listPage(body, p, DB_PAGES[page]);
}

// ---------- advisors ----------
const ADVISOR_CHECKS = [
  { id: "rls_disabled", area: "security", level: "error", title: "Table is exposed without row-level security",
    why: "anon or authenticated can read or change every row of this table through the API, because row-level security is off.",
    sql: `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      and (has_table_privilege('anon', c.oid, 'select,insert,update,delete') or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')) order by 1`,
    fix: (r) => `alter table public.${JSON.stringify(r.name)} enable row level security;`, target: (r) => `public.${r.name}` },
  { id: "rls_no_policy", area: "security", level: "info", title: "Row-level security is on but there are no policies",
    why: "With no policy, the API returns no rows and rejects every write. Add a policy for the roles that should have access.",
    sql: `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
      and not exists (select 1 from pg_policy o where o.polrelid = c.oid) order by 1`,
    fix: (r) => `create policy "own rows" on public.${JSON.stringify(r.name)} for select to authenticated using (auth.uid() = user_id);\n-- change user_id to the column that holds the owner`, target: (r) => `public.${r.name}` },
  { id: "permissive_policy", area: "security", level: "warn", title: "Policy lets anonymous users change every row",
    why: "This policy allows writes to anon (or everyone) with a condition that is always true.",
    sql: `select policyname || ' on ' || tablename as name, tablename, policyname from pg_policies where schemaname = 'public' and cmd <> 'SELECT'
      and (qual = 'true' or with_check = 'true') and (roles && array['anon', 'public']::name[]) order by 1`,
    fix: (r) => `drop policy ${JSON.stringify(r.policyname)} on public.${JSON.stringify(r.tablename)};`, target: (r) => r.name },
  { id: "definer_fn", area: "security", level: "warn", title: "Function runs with its owner's privileges and can be called from the API",
    why: "A security definer function ignores row-level security for its owner. Anyone who may execute it can use that power.",
    sql: `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1`,
    fix: (r) => `revoke execute on function public.${r.name} from public, anon, authenticated;`, target: (r) => `public.${r.name}` },
  { id: "no_pk", area: "performance", level: "warn", title: "Table has no primary key",
    why: "Without a primary key rows cannot be addressed reliably, and updates and deletes through the API are harder to target.",
    sql: `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
      and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p') order by 1`,
    fix: (r) => `alter table public.${JSON.stringify(r.name)} add column id bigint generated always as identity primary key;`, target: (r) => `public.${r.name}` },
  { id: "fk_no_index", area: "performance", level: "info", title: "Foreign key has no index",
    why: "Deleting or updating rows in the referenced table scans this table without an index on the foreign key column.",
    sql: `select (select relname from pg_class where oid = c.conrelid) as tbl, a.attname as col, c.conname as name from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]) order by 1, 2`,
    fix: (r) => `create index on public.${JSON.stringify(r.tbl)} (${JSON.stringify(r.col)});`, target: (r) => `${r.tbl}.${r.col}` },
];

async function advisors(body, p) {
  let area = "security";
  const slot = h("div", { id: "advisor-slot" });
  let findings = [];
  const scan = async () => {
    clear(slot); slot.append(h("p", { class: "muted" }, "Checking…"));
    const out = [];
    await Promise.all(ADVISOR_CHECKS.map(async (c) => {
      try { for (const r of await catalog(c.sql)) out.push({ check: c, row: r }); } catch { /* a check that cannot run is skipped */ }
    }));
    findings = out;
    draw();
  };
  const draw = () => {
    clear(slot);
    const count = (a) => findings.filter((f) => f.check.area === a).length;
    const tabBtn = (a, label) => h("button", { class: `tab ${a === area ? "on" : ""}`, id: `adv-tab-${a}`, onclick: () => { area = a; draw(); } }, label, h("span", { class: "count" }, String(count(a))));
    const shown = findings.filter((f) => f.check.area === area).sort((a, b) => ["error", "warn", "info"].indexOf(a.check.level) - ["error", "warn", "info"].indexOf(b.check.level) || a.check.id.localeCompare(b.check.id));
    slot.append(h("div", { class: "tabs" }, tabBtn("security", "Security"), tabBtn("performance", "Performance")),
      shown.length ? h("div", { class: "findings" }, shown.map((f) => h("div", { class: `finding ${f.check.level}`, "data-check": f.check.id, "data-target": f.check.target(f.row) },
        h("div", { class: "row between" }, h("div", { class: "row" }, h("span", { class: `level ${f.check.level}` }, { error: "Error", warn: "Warning", info: "Info" }[f.check.level]), h("strong", null, f.check.title)),
          h("button", { class: "small", "data-action": "open-fix", onclick: () => openInSql(f.check.fix(f.row)) }, "Open fix in SQL editor")),
        h("div", { class: "mono target" }, f.check.target(f.row)), h("p", { class: "muted" }, f.check.why))))
        : h("div", { class: "empty card", id: "advisor-clear" }, `No ${area} issues found.`));
  };
  clear(body);
  body.append(h("div", null,
    h("div", { class: "page-head" }, h("h1", null, "Advisors"), h("button", { id: "adv-refresh", onclick: scan }, "Run checks again")),
    h("p", { class: "muted pagehint" }, "Checks of the public schema for common mistakes. They read the catalog only and change nothing; every suggested fix opens in the SQL editor for you to review and run."),
    slot));
  await scan();
}

// ---------- reports ----------
async function reports(body, p) {
  const range = h("select", { id: "report-range", "aria-label": "Time range" }, [[24, "Last 24 hours"], [72, "Last 3 days"], [168, "Last 7 days"]].map(([v, l]) => h("option", { value: v }, l)));
  const slot = h("div", { id: "report-slot" });
  const load = async () => {
    const hours = Number(range.value);
    const m = await api("GET", `/v1/projects/${p.ref}/metrics?hours=${hours}`);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    clear(slot);
    slot.append(
      h("div", { class: "metrics-head" }, h("div", { class: "num", id: "report-total" }, m.totals.requests.toLocaleString(), h("span", null, "Total Requests")),
        h("div", { class: "num" }, m.totals.successRate === null ? "—" : `${m.totals.successRate.toFixed(1)}%`, h("span", null, "Success Rate"))),
      metricsView(m, hours),
      h("div", { class: "tablewrap" }, h("table", { class: "data", id: "report-table" },
        h("thead", null, h("tr", null, ["Service", "Requests", "Client errors", "Server errors"].map((x) => h("th", null, x)))),
        h("tbody", null, Object.entries(SERVICE_LABELS).map(([k, label]) => h("tr", { "data-service": k },
          h("td", null, label), h("td", null, sum(m.services[k].requests).toLocaleString()), h("td", null, sum(m.services[k].warnings).toLocaleString()), h("td", null, sum(m.services[k].errors).toLocaleString())))))));
  };
  range.addEventListener("change", load);
  clear(body);
  body.append(h("div", null, h("div", { class: "page-head" }, h("h1", null, "Reports"), range),
    h("p", { class: "muted pagehint" }, "Requests through this project's API, by service. Counted per hour; warnings are client errors (4xx) and errors are server errors (5xx)."), slot));
  await load();
}

// ---------- pipelines ----------
const PIPELINE_STATUS = { healthy: "Healthy", failing: "Failing", paused: "Paused" };
const hostOf = (u) => { try { const x = new URL(u); return `${x.host}${x.pathname === "/" ? "" : x.pathname}`; } catch { return u; } };

async function pipelinesPage(body, p) {
  const base = `/v1/projects/${p.ref}/pipelines`;
  const slot = h("div", { id: "pipeline-slot" });
  let rows = [];
  const load = async () => { rows = await api("GET", base); draw(); };

  const showSecret = (name, secret) => dialog("Signing secret", () => h("div", { class: "stack" },
    h("p", null, `Copy the signing secret for “${name}” now. It is shown only once; if you lose it, rotate it.`),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Secret"), ...copyable(secret, { secret: true })),
    h("h3", null, "Verify a delivery"),
    h("pre", { id: "verify-snippet" }, 'const [t, v1] = req.headers["x-baas-signature"].match(/t=(\\d+),v1=(\\w+)/).slice(1);\nconst expected = crypto.createHmac("sha256", SECRET).update(`${t}.${rawBody}`).digest("hex");\nif (expected !== v1) throw new Error("bad signature");')), { confirmLabel: "Done" });

  const editor = async (pl) => {
    const tabs = (await api("GET", `/v1/projects/${p.ref}/tables`)).map((t) => t.name);
    const name = h("input", { id: "pl-name", name: "name", placeholder: "e.g. orders to billing", value: pl ? pl.name : "", autocomplete: "off", required: true });
    const url = h("input", { id: "pl-url", name: "url", type: "url", placeholder: "https://example.com/hooks/baas", value: pl ? pl.url : "", autocomplete: "off", required: true });
    const tableBoxes = tabs.map((t) => h("label", { class: "check" }, h("input", { type: "checkbox", "data-table": t, checked: pl ? pl.tables.includes(t) : false }), h("span", { class: "mono" }, t)));
    const eventBoxes = ["INSERT", "UPDATE", "DELETE"].map((e) => h("label", { class: "check" }, h("input", { type: "checkbox", "data-event": e, checked: pl ? pl.events.includes(e) : true }), e.charAt(0) + e.slice(1).toLowerCase() + "s"));
    const rowsBox = h("input", { type: "checkbox", id: "pl-rows", checked: pl ? pl.include_rows : true });
    const OPS = [["eq", "equals"], ["neq", "does not equal"], ["gt", "is greater than"], ["gte", "is at least"], ["lt", "is less than"], ["lte", "is at most"], ["in", "is one of"], ["null", "is empty"], ["notnull", "is not empty"]];
    const filters = JSON.parse(JSON.stringify(pl?.filters || {}));
    const colCache = {};
    const fbox = h("div", { class: "stack", id: "pl-filters" });
    const selectedTables = () => tableBoxes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.dataset.table);
    const drawFilters = async () => {
      const chosen = selectedTables();
      for (const t of chosen) colCache[t] ??= await columnsOf("public", t);
      clear(fbox);
      if (!chosen.length) { fbox.append(h("p", { class: "muted" }, "Choose a table first.")); return; }
      for (const t of chosen) {
        const conds = (filters[t] ??= []);
        fbox.append(h("div", { class: "filter-block", "data-table": t },
          h("div", { class: "row between" }, h("strong", { class: "mono" }, t), h("button", { type: "button", class: "small", "data-action": "add-cond", onclick: () => { conds.push({ column: colCache[t][0]?.name, op: "eq", value: "" }); drawFilters(); } }, "Add condition")),
          !conds.length ? h("p", { class: "muted" }, "Every row is sent.") : null,
          conds.map((c, i) => h("div", { class: "cond-row" },
            h("select", { class: "cond-col", "aria-label": "Column", onchange: (e) => { c.column = e.target.value; } }, colCache[t].map((x) => h("option", { value: x.name, selected: x.name === c.column }, x.name))),
            h("select", { class: "cond-op", "aria-label": "Condition", onchange: (e) => { c.op = e.target.value; drawFilters(); } }, OPS.map(([v, l]) => h("option", { value: v, selected: v === c.op }, l))),
            c.op === "null" || c.op === "notnull" ? h("span") : h("input", { class: "cond-val", "aria-label": "Value", placeholder: c.op === "in" ? "a, b, c" : "value", autocomplete: "off", value: Array.isArray(c.value) ? c.value.join(", ") : (c.value ?? ""), oninput: (e) => { c.value = e.target.value; } }),
            h("button", { type: "button", class: "iconbtn", "aria-label": "Remove condition", onclick: () => { conds.splice(i, 1); drawFilters(); } }, icon("x", 14))))));
      }
    };
    for (const l of tableBoxes) l.querySelector("input").addEventListener("change", drawFilters);
    await drawFilters();
    const field = (label, el, hint) => h("div", { class: "form-row" }, h("label", null, label), h("div", null, el, hint ? h("p", { class: "muted hint" }, hint) : null));
    return dialog(pl ? `Edit ${pl.name}` : "New pipeline", () => h("div", { class: "stack" },
      field("Name", name),
      field("Tables", tabs.length ? h("div", { class: "checks", id: "pl-tables" }, tableBoxes) : h("p", { class: "muted" }, "No tables yet. Create one first."), "Changes to these tables are sent. Only new changes: nothing already in the table is replayed."),
      field("Events", h("div", { class: "checks", id: "pl-events" }, eventBoxes)),
      field("Only rows where", fbox, "Optional. A change is sent only if the row matches every condition as it is when delivered. Deletes carry no row, so they are always sent: turn them off under Events if you do not want that."),
      field("Destination URL", url, "Must be reachable from this server. Addresses on private networks are refused unless the operator allows them."),
      field("Row data", h("label", { class: "check" }, rowsBox, "Include the row in each event"), "Rows are read with full access, ignoring row-level security, and are the row as it is at delivery time. Turn this off to send only the primary key."),
    ), {
      sheet: true, confirmLabel: pl ? "Save pipeline" : "Create pipeline",
      onSubmit: async () => {
        const tablesSel = tableBoxes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.dataset.table);
        const eventsSel = eventBoxes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.dataset.event);
        if (!name.value.trim()) throw new Error("Give the pipeline a name.");
        if (!tablesSel.length) throw new Error("Choose at least one table.");
        if (!eventsSel.length) throw new Error("Choose at least one event.");
        const outFilters = {};
        for (const t of tablesSel) {
          const list = (filters[t] || []).map((c) => {
            if (c.op === "null" || c.op === "notnull") return { column: c.column, op: c.op };
            if (c.op === "in") {
              const v = String(Array.isArray(c.value) ? c.value.join(",") : c.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
              if (!v.length) throw new Error(`Give ${t}.${c.column} at least one value.`);
              return { column: c.column, op: "in", value: v };
            }
            if (c.value === undefined || c.value === null || String(c.value).trim() === "") throw new Error(`Give a value for the condition on ${t}.${c.column}.`);
            return { column: c.column, op: c.op, value: String(c.value).trim() };
          });
          if (list.length) outFilters[t] = list;
        }
        const payload = { name: name.value.trim(), tables: tablesSel, events: eventsSel, url: url.value.trim(), include_rows: rowsBox.checked, filters: outFilters };
        return pl ? { saved: await api("PATCH", `${base}/${pl.id}`, payload) } : { created: await api("POST", base, payload) };
      },
    });
  };

  const deliveriesDialog = async (pl) => {
    const log = await api("GET", `${base}/${pl.id}/deliveries`);
    return dialog(`Deliveries for ${pl.name}`, () => log.length
      ? h("div", { class: "tablewrap" }, h("table", { class: "data", id: "delivery-table" },
        h("thead", null, h("tr", null, ["When", "Kind", "Result", "Events", "Time"].map((x) => h("th", null, x)))),
        h("tbody", null, log.map((d) => h("tr", { "data-ok": String(d.ok) },
          h("td", { title: fmtDate(d.at) }, ago(d.at)), h("td", null, d.kind === "test" ? "Test" : "Changes"),
          h("td", { class: d.ok ? "ok" : "bad", title: d.error || "" }, d.ok ? `OK ${d.status}` : (d.error || "Failed")),
          h("td", null, String(d.events)), h("td", null, `${d.ms} ms`))))))
      : h("p", { class: "muted" }, "Nothing has been sent yet. Deliveries appear here after the first change or test event."), { confirmLabel: "Close" });
  };

  const act = async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg, "ok"); await load(); return r; } catch (ex) { toast(ex.message, "bad"); await load().catch(() => {}); } };

  const menuFor = (pl) => rowMenu([
    ["View deliveries", () => deliveriesDialog(pl), { action: "deliveries" }],
    ["Send test event", () => act(async () => { const r = await api("POST", `${base}/${pl.id}/test`); if (!r.ok) throw new Error(`Test failed: ${r.error || r.status}`); return r; }, "Test event delivered"), { action: "test" }],
    ["Deliver pending changes now", () => act(() => api("POST", `${base}/${pl.id}/run`), "Checked for changes"), { action: "run" }],
    [pl.enabled ? "Pause" : "Resume", () => act(() => api("PATCH", `${base}/${pl.id}`, { enabled: !pl.enabled }), pl.enabled ? "Pipeline paused" : "Pipeline resumed"), { action: "toggle" }],
    ["Edit", async () => { const r = await editor(pl); if (r) { toast("Pipeline saved", "ok"); await load(); } }, { action: "edit" }],
    ["Rotate secret", async () => {
      if (!(await confirmBox("Rotate the signing secret?", "Deliveries are signed with the new secret straight away. Update your receiver first or right after, or it will reject them.", { danger: false, confirmLabel: "Rotate secret" }))) return;
      try { const r = await api("POST", `${base}/${pl.id}/rotate-secret`); await showSecret(pl.name, r.secret); } catch (ex) { toast(ex.message, "bad"); }
    }, { action: "rotate" }],
    ["Delete", async () => {
      if (!(await confirmBox("Delete pipeline", `Delete “${pl.name}”? Changes not yet delivered are dropped.`, { typed: pl.name, confirmLabel: "Delete pipeline" }))) return;
      await act(() => api("DELETE", base + `/${pl.id}`), "Pipeline deleted");
    }, { danger: true, action: "delete" }],
  ]);

  function draw() {
    clear(slot);
    if (!rows.length) {
      slot.append(h("div", { class: "empty card", id: "pipeline-empty" }, h("strong", null, "No pipelines yet"),
        h("p", { class: "muted" }, "A pipeline sends the changes to your tables (inserts, updates and deletes) to a URL you control, signed so you can trust them. Use it to keep another system in sync, or to react to changes.")));
      return;
    }
    slot.append(h("div", { class: "tablewrap" }, h("table", { class: "data", id: "pipeline-table" },
      h("thead", null, h("tr", null, ["Name", "Tables", "Destination", "Status", "Delivered", "Last delivery", ""].map((x) => h("th", null, x)))),
      h("tbody", null, rows.map((pl) => h("tr", { "data-row": pl.name },
        h("td", null, pl.name), h("td", { class: "mono-cell", title: pl.tables.join(", ") }, pl.tables.map((t) => (pl.filters?.[t]?.length ? `${t} (filtered)` : t)).join(", ")), h("td", { class: "mono-cell", title: hostOf(pl.url) }, hostOf(pl.url)),
        h("td", null, h("span", { class: `chip ${pl.status}`, "data-status": pl.status, title: pl.disabled_reason || pl.last_error || "" }, PIPELINE_STATUS[pl.status])),
        h("td", { "data-delivered": String(pl.delivered) }, pl.delivered.toLocaleString()), h("td", { title: pl.last_error || "" }, pl.last_success_at ? ago(pl.last_success_at) : (pl.last_attempt_at ? `failed ${ago(pl.last_attempt_at)}` : "never")),
        h("td", { class: "actions-cell" }, h("div", { class: "row" }, menuFor(pl)))))))));
  }

  clear(body);
  body.append(h("div", null,
    h("div", { class: "page-head" }, h("h1", null, "Pipelines"),
      h("button", { class: "primary", id: "new-pipeline", onclick: async () => {
        const r = await editor(null);
        if (r?.created) { toast("Pipeline created", "ok"); await load(); await showSecret(r.created.name, r.created.secret); }
      } }, icon("plus", 15), " New pipeline")),
    h("p", { class: "muted pagehint" }, "Send row changes to a webhook. Delivery is at least once and in order, retried with a growing delay, and a pipeline pauses itself after repeated failures."),
    slot));
  await load();
  const timer = setInterval(() => { if (!body.isConnected) return clearInterval(timer); load().catch(() => {}); }, 5000);
}

// ---------- integrations ----------
async function integrations(body, p) {
  const base = `/v1/projects/${p.ref}`;
  const services = h("div", { class: "integ-grid", id: "integration-services" });
  const extGrid = h("div", { class: "integ-grid", id: "extension-grid" });
  const cards = [];
  const add = (key, title, text, status, href) => services.append(h("a", { class: "integ-card service-card", href, "data-service": key },
    h("div", { class: "row between" }, h("strong", null, title), status ? h("span", { class: `chip ${status.kind}` }, status.text) : null), h("p", { class: "muted" }, text)));
  const [ai, pls, fns] = await Promise.all([api("GET", `${base}/ai`).catch(() => null), api("GET", `${base}/pipelines`).catch(() => null), api("GET", `${base}/functions`).catch(() => null)]);
  add("ai", "Ask AI", "Ask questions about your data in plain language; changes are proposed, never run for you.", ai ? { kind: ai.enabled ? "healthy" : "paused", text: ai.enabled ? "On" : ai.available === false ? "Not configured" : "Off" } : null, `#/p/${p.ref}/ai`);
  add("pipelines", "Pipelines", "Send row changes to a webhook, signed and retried.", pls ? { kind: pls.some((x) => x.status === "failing") ? "failing" : pls.length ? "healthy" : "paused", text: pls.length ? `${pls.length} active` : "None" } : null, `#/p/${p.ref}/database/pipelines`);
  add("functions", "Edge Functions", "Run your own code next to your data, called over HTTPS.", fns ? { kind: fns.length ? "healthy" : "paused", text: fns.length ? `${fns.length} deployed` : "None" } : null, `#/p/${p.ref}/functions`);
  add("realtime", "Realtime", "Stream row changes to browsers over a WebSocket, respecting row-level security.", null, `#/p/${p.ref}/realtime`);
  add("storage", "Storage", "Files in buckets, with access rules and signed URLs.", null, `#/p/${p.ref}/storage`);

  let exts = [], forbidden = null, q = "", show = "all";
  const drawExt = () => {
    clear(extGrid);
    if (forbidden) { extGrid.append(h("div", { class: "notice warn" }, forbidden)); return; }
    const list = exts.filter((e) => (!q || `${e.name} ${e.comment || ""}`.toLowerCase().includes(q.toLowerCase())) && (show === "all" || (show === "installed") === e.installed));
    if (!list.length) { extGrid.append(h("div", { class: "empty" }, "No matching extensions.")); return; }
    const rank = (e) => (e.installed ? 0 : e.installable ? 1 : 2);
    list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    for (const e of list) {
      const why = e.protected ? "Used by the platform" : !e.installable && !e.installed ? "Needs the server operator" : "";
      const btn = e.installed
        ? h("button", { class: "small", "data-action": "remove", disabled: e.protected, title: why, onclick: () => toggle(e, false) }, "Remove")
        : h("button", { class: "small primary", "data-action": "install", disabled: !e.installable, title: why, onclick: () => toggle(e, true) }, "Install");
      extGrid.append(h("div", { class: `integ-card ext-card ${e.installed ? "on" : ""} ${!e.installed && !e.installable ? "na" : ""}`, "data-ext": e.name },
        h("div", { class: "row between" }, h("strong", { class: "mono" }, e.name), e.installed ? h("span", { class: "chip healthy" }, "Installed") : null),
        h("p", { class: "muted" }, e.comment || "No description."),
        h("div", { class: "row between" }, h("span", { class: "muted mono" }, `v${e.installed_version || e.version}${e.installed && e.schema ? ` · ${e.schema}` : ""}`), btn)));
    }
  };
  const toggle = async (e, install) => {
    if (!install && !(await confirmBox("Remove extension", `Remove ${e.name}? Anything that uses it will stop working.`, { typed: e.name, confirmLabel: "Remove extension" }))) return;
    try { const r = await api("POST", `${base}/extensions`, { name: e.name, install }); Object.assign(e, r); toast(install ? `${e.name} installed` : `${e.name} removed`, "ok"); drawExt(); } catch (ex) { toast(ex.message, "bad"); }
  };
  try { exts = await api("GET", `${base}/extensions`); } catch (ex) { forbidden = /requires/.test(ex.message) ? "Installing extensions needs the admin role." : ex.message; }
  drawExt();

  clear(body);
  body.append(h("div", { class: "stack-lg" },
    h("div", null, h("div", { class: "page-head" }, h("h1", null, "Integrations")),
      h("p", { class: "muted pagehint" }, "What this project connects to, and the Postgres extensions you can turn on."), h("h2", null, "Built in"), services),
    h("div", null, h("h2", null, "Postgres extensions"),
      h("p", { class: "muted pagehint" }, "Extensions install into the extensions schema, so call their functions as extensions.name(). Only extensions Postgres marks as safe for database owners can be installed here."),
      h("div", { class: "toolbar" },
        h("input", { id: "ext-search", placeholder: "Search extensions", "aria-label": "Search extensions", oninput: (e) => { q = e.target.value; drawExt(); } }),
        h("select", { id: "ext-filter", "aria-label": "Show", onchange: (e) => { show = e.target.value; drawExt(); } }, [["all", "All"], ["installed", "Installed"], ["available", "Not installed"]].map(([v, l]) => h("option", { value: v }, l)))),
      extGrid)));
}

// ---------- authentication ----------
async function authPage(body, p, page) {
  const cfg = await api("GET", `/v1/projects/${p.ref}/auth-config`);
  const canEdit = S.me.role !== "developer";
  const pages = { users: authUsers, providers: authProviders, urls: authUrls, email: authEmail, sessions: authSessions };
  await pages[page](body, p, cfg, canEdit);
}

const saveAuthSettings = async (p, patch) => { const r = await api("PATCH", `/v1/projects/${p.ref}/settings`, patch); await refreshProject().catch(() => {}); return r; };
const needAdmin = (canEdit) => (canEdit ? null : h("div", { class: "notice warn" }, "Changing these settings needs the admin role."));

async function authUsers(body, p, cfg) {
  const load = async () => (await gw("/auth/v1/admin/users?per_page=100")).data;
  let { users, total } = await load();
  const mailTo = async (path, email, ok) => { try { await gw(path, { method: "POST", body: { email } }); toast(ok, "ok"); } catch (ex) { toast(ex.message, "bad"); } };
  const draw = () => {
    clear(body);
    body.append(h("div", { class: "stack" },
      h("div", { class: "page-head" }, h("h1", null, "Users ", h("span", { class: "muted", id: "user-count" }, `(${total})`)),
        h("button", { class: "primary", id: "new-user", onclick: async () => {
          const confirmBox_ = h("input", { type: "checkbox", id: "user-confirm", checked: true });
          const u = await dialog("Create user", () => h("div", { class: "stack" },
            h("label", { class: "field" }, "Email", h("input", { name: "email", type: "email", required: true, id: "user-email" })),
            h("label", { class: "field" }, "Password", h("input", { name: "password", type: "password", required: true, minlength: 6, id: "user-password" })),
            h("label", { class: "check" }, confirmBox_, "Mark the email address as confirmed")), {
            confirmLabel: "Create user", onSubmit: async (fd) => (await gw("/auth/v1/admin/users", { method: "POST", body: { email: fd.get("email"), password: fd.get("password"), email_confirm: confirmBox_.checked } })).data,
          });
          if (u) { toast("User created", "ok"); ({ users, total } = await load()); draw(); }
        } }, "Create user")),
      h("div", { class: "tablewrap" }, users.length
        ? h("table", { class: "data", id: "users" },
          h("thead", null, h("tr", null, ["Email", "ID", "Created", "Last sign in", "Status", ""].map((x) => h("th", null, x)))),
          h("tbody", null, users.map((u) => {
            const banned = u.banned_until && new Date(u.banned_until) > new Date();
            const unconfirmed = !u.email_confirmed_at;
            const mail = [];
            if (cfg.email_delivery && u.email) {
              mail.push(["Send password recovery", () => mailTo("/auth/v1/recover", u.email, `Recovery email sent to ${u.email}`), { action: "send-recovery" }]);
              mail.push(["Send magic link", () => mailTo("/auth/v1/magiclink", u.email, `Sign-in link sent to ${u.email}`), { action: "send-magic" }]);
              if (unconfirmed) mail.push(["Resend confirmation email", () => mailTo("/auth/v1/resend", u.email, `Confirmation email sent to ${u.email}`), { action: "resend-confirm" }]);
            }
            const verified = (u.factors || []).filter((f) => f.status === "verified");
            if (verified.length) mail.push(["Remove authenticator (MFA)", async () => {
              if (!(await confirmBox("Remove authenticator", `Remove the second factor from ${u.email}? Use this when they lost their device. Their sessions that used it end, and anyone with their password can then sign in without a code.`, { confirmLabel: "Remove authenticator" }))) return;
              try { await gw(`/auth/v1/admin/users/${u.id}/factors`, { method: "DELETE" }); toast("Authenticator removed", "ok"); ({ users, total } = await load()); draw(); } catch (ex) { toast(ex.message, "bad"); }
            }, { danger: true, action: "remove-mfa" }]);
            if (unconfirmed) mail.push(["Mark email as confirmed", async () => { try { await gw(`/auth/v1/admin/users/${u.id}`, { method: "PUT", body: { email_confirm: true } }); toast("Email confirmed", "ok"); ({ users, total } = await load()); draw(); } catch (ex) { toast(ex.message, "bad"); } }, { action: "confirm-email" }]);
            return h("tr", { "data-email": u.email || u.phone },
              h("td", null, u.email || u.phone, !u.email && u.phone && h("span", { class: "chip", title: "Signs in with a text message" }, "phone")), h("td", { class: "mono" }, u.id), h("td", null, fmtDate(u.created_at)), h("td", null, fmtDate(u.last_sign_in_at)),
              h("td", null, banned ? h("span", { class: "bad" }, "banned") : unconfirmed ? h("span", { class: "warn", "data-status": "unconfirmed", title: "Has not confirmed the email address" }, "unconfirmed") : "active",
                (u.factors || []).some((f) => f.status === "verified") ? h("span", { class: "chip healthy", "data-mfa": "on", title: "Has an authenticator app set up" }, "MFA") : null),
              h("td", { class: "row" },
                h("button", { class: "small", onclick: async () => { await gw(`/auth/v1/admin/users/${u.id}`, { method: "PUT", body: { ban_duration: banned ? "none" : "876000h" } }); toast(banned ? "User unbanned" : "User banned", "ok"); ({ users, total } = await load()); draw(); } }, banned ? "Unban" : "Ban"),
                h("button", { class: "small danger", "data-action": "delete-user", onclick: async () => { if (await confirmBox("Delete user", `Delete ${u.email || u.phone}? Their sessions end immediately.`, { confirmLabel: "Delete" })) { await gw(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" }); toast("User deleted", "ok"); ({ users, total } = await load()); draw(); } } }, "Delete"),
                mail.length ? rowMenu(mail) : null));
          })))
        : h("div", { class: "empty" }, "No users yet. They appear here when someone signs up through the API."))));
  };
  draw();
}

// ---------- authentication settings ----------
const PROVIDER_HELP = {
  google: "Create an OAuth client (type Web application) in the Google Cloud console under APIs & Services → Credentials.",
  github: "Create an OAuth App under GitHub → Settings → Developer settings → OAuth Apps.",
  gitlab: "Create an application under GitLab → User settings → Applications, with the read_user, openid and email scopes.",
  discord: "Create an application at discord.com/developers/applications and add the redirect under OAuth2.",
  microsoft: "Register an app in the Microsoft Entra admin center (App registrations) and add the redirect as a Web platform URI.",
};

async function authProviders(body, p, cfg, canEdit) {
  const slot = h("div", { id: "provider-slot" });
  let state = cfg;
  const sheet = async (pr) => {
    const enabled = h("input", { type: "checkbox", id: "prov-enabled", checked: pr.enabled });
    const clientId = h("input", { id: "prov-client-id", autocomplete: "off", value: pr.client_id, placeholder: "Client ID" });
    const secret = h("input", { id: "prov-secret", type: "password", autocomplete: "new-password", placeholder: pr.secret_set ? "A secret is saved. Leave empty to keep it." : "Client secret" });
    const ok = await dialog(`Sign in with ${pr.label}`, () => h("div", { class: "stack" },
      h("p", { class: "muted" }, PROVIDER_HELP[pr.id]),
      formRow("Callback URL", h("div", { class: "kv" }, ...copyable(state.callback_url)), "Add this as the authorized redirect URI in the provider's settings."),
      formRow("Enabled", h("label", { class: "check" }, enabled, `Let people sign in with ${pr.label}`)),
      formRow("Client ID", clientId), formRow("Client secret", secret, "Stored encrypted and never shown again."),
      h("p", { class: "muted" }, `People who sign in this way get an account with the email address ${pr.label} verified for them. It is linked to an existing account only when ${pr.label} confirms the address.`)), {
      sheet: true, confirmLabel: "Save",
      onSubmit: async () => {
        const entry = { enabled: enabled.checked, client_id: clientId.value.trim() };
        if (secret.value) entry.secret = secret.value;
        await saveAuthSettings(p, { auth_providers: { [pr.id]: entry } });
        return true;
      },
    });
    if (ok) { toast(`${pr.label} saved`, "ok"); state = await api("GET", `/v1/projects/${p.ref}/auth-config`); draw(); }
  };
  /** A provider that speaks OpenID Connect: only the issuer is needed, the endpoints come from its discovery document. */
  const customSheet = async (pr) => {
    const isNew = !pr;
    const cur = pr || { id: "", label: "", issuer: "", client_id: "", scopes: "openid email profile", enabled: true, secret_set: false };
    const slug = h("input", { id: "oidc-id", autocomplete: "off", value: cur.id, placeholder: "acme-sso", pattern: "[a-z][a-z0-9\\-]{1,30}", required: true, disabled: !isNew });
    const label = h("input", { id: "oidc-label", autocomplete: "off", value: cur.label, placeholder: "Acme SSO" });
    const issuer = h("input", { id: "oidc-issuer", type: "url", autocomplete: "off", value: cur.issuer, placeholder: "https://login.example.com", required: true });
    const clientId = h("input", { id: "oidc-client-id", autocomplete: "off", value: cur.client_id, required: true });
    const secret = h("input", { id: "oidc-secret", type: "password", autocomplete: "new-password", placeholder: cur.secret_set ? "A secret is saved. Leave empty to keep it." : "Client secret" });
    const scopes = h("input", { id: "oidc-scopes", autocomplete: "off", value: cur.scopes });
    const enabled = h("input", { type: "checkbox", id: "oidc-enabled", checked: cur.enabled });
    const ok = await dialog(isNew ? "Add a custom provider" : `Sign in with ${cur.label || cur.id}`, () => h("div", { class: "stack" },
      h("p", { class: "muted" }, "Any provider that supports OpenID Connect: Okta, Auth0, Keycloak, Microsoft Entra, your own. Baas reads its settings from <issuer>/.well-known/openid-configuration and checks every sign-in's ID token."),
      formRow("Callback URL", h("div", { class: "kv" }, ...copyable(state.callback_url)), "Add this as the redirect URI when you register baas with the provider."),
      formRow("Name", slug, isNew ? "Lowercase letters, digits and dashes. Used in the sign-in URL (?provider=name)." : "Fixed once created, because it is saved with each person's identity."),
      formRow("Label", label, "Shown on the sign-in button."),
      formRow("Issuer", issuer, "The provider's address, exactly as it names itself. It must use https and be reachable from this server."),
      formRow("Client ID", clientId), formRow("Client secret", secret, "Stored encrypted and never shown again."),
      formRow("Scopes", scopes, "Space separated; must include openid."),
      formRow("Enabled", h("label", { class: "check" }, enabled, "Let people sign in with it")),
      h("p", { class: "muted" }, "An existing account is linked only when the provider says the email address is verified.")), {
      sheet: true, confirmLabel: "Save",
      onSubmit: async () => {
        const entry = { enabled: enabled.checked, label: label.value.trim() || slug.value.trim(), issuer: issuer.value.trim(), client_id: clientId.value.trim(), scopes: scopes.value.trim() || "openid email profile" };
        if (secret.value) entry.secret = secret.value;
        await saveAuthSettings(p, { oidc_providers: { [cur.id || slug.value.trim()]: entry } });
        return true;
      },
    });
    if (ok) { toast("Provider saved", "ok"); state = await api("GET", `/v1/projects/${p.ref}/auth-config`); draw(); }
  };
  const draw = () => {
    clear(slot);
    slot.append(h("div", { class: "tablewrap" }, h("table", { class: "data", id: "provider-table" },
      h("thead", null, h("tr", null, ["Provider", "Status", "Client ID", ""].map((x) => h("th", null, x)))),
      h("tbody", null,
        h("tr", { "data-row": "email" }, h("td", null, "Email"), h("td", null, h("span", { class: "chip healthy" }, "Enabled")), h("td", { class: "muted" }, "Built in"), h("td", { class: "actions-cell" }, h("a", { href: `#/p/${p.ref}/auth/email` }, "Email settings"))),
        h("tr", { "data-row": "phone" }, h("td", null, "Phone"), h("td", null, h("span", { class: `chip ${state.sms_delivery ? "healthy" : "paused"}`, "data-status": state.sms_delivery ? "enabled" : "unavailable" }, state.sms_delivery ? "Enabled" : "Needs a text provider")),
          h("td", { class: "muted" }, state.sms_delivery ? "Sign in with a code sent by text" : "The operator sets TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM"), h("td", { class: "actions-cell" })),
        state.providers.map((pr) => h("tr", { "data-row": pr.id },
          h("td", null, h("button", { class: "linkish", "data-action": "configure", disabled: !canEdit, onclick: () => sheet(pr) }, pr.label)),
          h("td", null, h("span", { class: `chip ${pr.enabled ? "healthy" : "paused"}`, "data-status": pr.enabled ? "enabled" : "disabled" }, pr.enabled ? "Enabled" : pr.secret_set ? "Disabled" : "Not set up")),
          h("td", { class: "mono-cell" }, pr.client_id || "—"),
          h("td", { class: "actions-cell" }, canEdit ? h("button", { class: "small", onclick: () => sheet(pr) }, "Configure") : null))),
        (state.custom_providers || []).map((pr) => h("tr", { "data-row": pr.id, "data-custom": "true" },
          h("td", null, h("button", { class: "linkish", "data-action": "configure", disabled: !canEdit, onclick: () => customSheet(pr) }, pr.label), h("span", { class: "chip" }, "OIDC")),
          h("td", null, h("span", { class: `chip ${pr.enabled ? "healthy" : "paused"}`, "data-status": pr.enabled ? "enabled" : "disabled" }, pr.enabled ? "Enabled" : "Disabled")),
          h("td", { class: "mono-cell" }, pr.client_id || "—"),
          h("td", { class: "actions-cell" }, canEdit ? [h("button", { class: "small", onclick: () => customSheet(pr) }, "Configure"), " ", h("button", { class: "small", "data-action": "remove-provider", onclick: async () => {
            if (!(await confirmBox("Remove provider", `People who signed in with ${pr.label} keep their accounts but cannot use it to sign in until you add it again.`, { confirmLabel: "Remove" }))) return;
            try { await saveAuthSettings(p, { oidc_providers: { [pr.id]: null } }); toast("Provider removed", "ok"); state = await api("GET", `/v1/projects/${p.ref}/auth-config`); draw(); } catch (ex) { toast(ex.message, "bad"); }
          } }, "Remove")] : null)))))),
      canEdit && h("div", { class: "row mt" }, h("button", { id: "add-oidc", onclick: () => customSheet(null) }, "Add custom provider (OpenID Connect)")));
  };
  clear(body);
  body.append(h("div", null, h("div", { class: "page-head" }, h("h1", null, "Sign-in providers")),
    h("p", { class: "muted pagehint" }, "Let people sign in with an account they already have. Each provider needs an app registered with them; its client ID and secret go here."),
    needAdmin(canEdit),
    h("div", { class: "notice", id: "callback-note" }, h("strong", null, "Callback URL "), h("code", { class: "mono" }, cfg.callback_url || "—")),
    slot));
  draw();
}

async function authUrls(body, p, cfg, canEdit) {
  const s = cfg.settings;
  const site = h("input", { id: "auth-site-url", type: "url", placeholder: "https://myapp.example.com", value: s.site_url || "", autocomplete: "off", disabled: !canEdit });
  const list = h("textarea", { id: "auth-redirects", class: "code", rows: 6, placeholder: "https://myapp.example.com/**\nmyapp://callback", disabled: !canEdit, spellcheck: "false" }, (s.redirect_urls || []).join("\n"));
  const cors = h("textarea", { id: "auth-cors", class: "code", rows: 4, placeholder: "https://myapp.example.com\nhttps://*.preview.example.com", disabled: !canEdit, spellcheck: "false" }, (s.cors_origins || []).join("\n"));
  const w = s.webauthn || {};
  const rpId = h("input", { id: "auth-rp-id", placeholder: "app.example.com (default: the site URL's host)", value: w.rp_id || "", autocomplete: "off", disabled: !canEdit });
  const rpOrigins = h("textarea", { id: "auth-rp-origins", class: "code", rows: 3, placeholder: "https://app.example.com (default: the site URL's origin)", disabled: !canEdit, spellcheck: "false" }, (w.origins || []).join("\n"));
  const needUv = h("input", { type: "checkbox", id: "auth-rp-uv", checked: w.require_user_verification === true, disabled: !canEdit });
  clear(body);
  body.append(h("div", { class: "stack" }, h("div", { class: "page-head" }, h("h1", null, "URL configuration")),
    h("p", { class: "muted pagehint" }, "Where emailed links and provider sign-ins may send people back to. Anything else is refused, so a link cannot be pointed at someone else's site."),
    needAdmin(canEdit),
    h("div", { class: "card stack" },
      formRow("Site URL", site, "Your app's main address. Links in emails go here when the app does not ask for somewhere else, and any address on the same origin is allowed."),
      formRow("Redirect URLs", list, "More addresses that are allowed, one per line. End with * to allow everything that starts that way, for example https://preview.example.com/*. App deep links such as myapp://callback work too."),
      formRow("Browser origins (CORS)", cors, "Websites allowed to read this project's API from a browser. Leave empty to allow every website. One origin per line, like https://myapp.example.com; https://*.example.com matches subdomains. This protects your users' browsers; it does not stop servers or scripts, which your API keys control. This dashboard is always allowed."),
      h("h3", null, "Passkeys"),
      h("p", { class: "muted" }, "Passkeys and security keys as a second factor are tied to your app's website. By default that is the site URL; set these only if your app lives on several origins or a different domain."),
      formRow("Relying party ID", rpId, "A domain your app's pages are on, without scheme or port. Passkeys only work on that domain and its subdomains."),
      formRow("Allowed origins", rpOrigins, "One origin per line, exactly as the browser shows it (https://app.example.com; plain http only for localhost)."),
      formRow("Verification", h("label", { class: "check" }, needUv, "Require a PIN or biometric, not just a touch")),
      h("div", { class: "row" }, h("button", { class: "primary", id: "save-urls", disabled: !canEdit, onclick: async () => {
        try {
          const lines = list.value.split("\n").map((x) => x.trim()).filter(Boolean);
          const patch = { redirect_urls: lines, cors_origins: cors.value.split("\n").map((x) => x.trim()).filter(Boolean) };
          if (site.value.trim()) patch.site_url = site.value.trim();
          const origins = rpOrigins.value.split("\n").map((x) => x.trim()).filter(Boolean);
          patch.webauthn = { ...(rpId.value.trim() ? { rp_id: rpId.value.trim() } : {}), ...(origins.length ? { origins } : {}), ...(needUv.checked ? { require_user_verification: true } : {}) };
          await saveAuthSettings(p, patch);
          toast("URL configuration saved", "ok");
        } catch (ex) { toast(ex.message, "bad"); }
      } }, "Save")))));
}

async function authEmail(body, p, cfg, canEdit) {
  const s = cfg.settings;
  const KINDS = [["confirmation", "Confirm sign-up"], ["recovery", "Reset password"], ["magic_link", "Magic link"]];
  const custom = JSON.parse(JSON.stringify(s.email_templates || {}));
  const val = (k, f) => custom[k]?.[f] || cfg.templates[k][f];
  const confirm = h("input", { type: "checkbox", id: "auth-email-confirm", checked: s.email_confirm === true, disabled: !canEdit || !cfg.email_delivery });
  const from = h("input", { id: "auth-from-name", value: s.mailer_from_name || "", placeholder: "Shown as the sender's name", maxlength: 60, autocomplete: "off", disabled: !canEdit });
  const kind = h("select", { id: "tpl-kind", "aria-label": "Template" }, KINDS.map(([v, l]) => h("option", { value: v }, l)));
  const subject = h("input", { id: "tpl-subject", maxlength: 200, autocomplete: "off", disabled: !canEdit });
  const text = h("textarea", { id: "tpl-body", class: "code", rows: 10, spellcheck: "false", disabled: !canEdit });
  const load = () => { subject.value = val(kind.value, "subject"); text.value = val(kind.value, "body"); };
  let last = kind.value;
  const keep = () => { custom[last] = { subject: subject.value, body: text.value }; };
  kind.addEventListener("change", () => { keep(); last = kind.value; load(); });
  load();
  clear(body);
  body.append(h("div", { class: "stack" }, h("div", { class: "page-head" }, h("h1", null, "Email")),
    cfg.email_delivery
      ? h("div", { class: "notice", id: "mail-on" }, "Email delivery is set up on this server.")
      : h("div", { class: "notice warn", id: "mail-off" }, "This server has no email delivery, so confirmation, password reset and magic-link emails are switched off and new users are confirmed automatically. The server's operator turns it on by setting SMTP_URL."),
    needAdmin(canEdit),
    h("div", { class: "card stack" }, h("h3", null, "Sign-up"),
      h("label", { class: "check" }, confirm, "Require people to confirm their email address before they can sign in"),
      formRow("Sender name", from, "Appears as the name on every email this project sends.")),
    h("div", { class: "card stack" }, h("h3", null, "Templates"),
      h("p", { class: "muted" }, "Plain text. Variables: {{ .ConfirmationURL }} is the link, {{ .Email }} the person's address, {{ .Token }} a six-digit code for apps that cannot open a link, {{ .SiteURL }} your site URL."),
      formRow("Email", kind), formRow("Subject", subject), formRow("Message", text),
      h("div", { class: "row" },
        h("button", { class: "primary", id: "save-email", disabled: !canEdit, onclick: async () => {
          try {
            keep();
            const templates = {};
            for (const [k] of KINDS) {
              const c = custom[k] || {};
              templates[k] = { subject: c.subject && c.subject !== cfg.templates[k].subject ? c.subject : "", body: c.body && c.body !== cfg.templates[k].body ? c.body : "" };
            }
            const patch = { mailer_from_name: from.value.trim(), email_templates: templates };
            if (cfg.email_delivery) patch.email_confirm = confirm.checked;
            await saveAuthSettings(p, patch);
            toast("Email settings saved", "ok");
          } catch (ex) { toast(ex.message, "bad"); }
        } }, "Save"),
        h("button", { id: "reset-template", disabled: !canEdit, onclick: () => { custom[last] = { subject: cfg.templates[last].subject, body: cfg.templates[last].body }; load(); } }, "Reset this template")))));
}

async function authSessions(body, p, cfg, canEdit) {
  const s = cfg.settings;
  const expiry = h("input", { id: "set-expiry", type: "number", min: 60, max: 604800, value: s.jwt_expiry ?? 3600, disabled: !canEdit });
  const minpw = h("input", { id: "set-minpw", type: "number", min: 6, max: 64, value: s.password_min_length ?? 6, disabled: !canEdit });
  const disable = h("input", { id: "set-disable", type: "checkbox", checked: s.disable_signup === true, disabled: !canEdit });
  clear(body);
  body.append(h("div", { class: "stack" }, h("div", { class: "page-head" }, h("h1", null, "Sessions and sign-ups")),
    needAdmin(canEdit),
    h("div", { class: "card stack" },
      formRow("Access token lifetime", expiry, "In seconds, between 60 and 604800 (a week). Apps refresh it automatically with the longer-lived refresh token."),
      formRow("Minimum password length", minpw, "Between 6 and 64 characters. Applies to new passwords."),
      formRow("New sign-ups", h("label", { class: "check" }, disable, "Disable new sign-ups"), "Existing users can still sign in, and you can still create users here."),
      h("div", { class: "row" }, h("button", { class: "primary", id: "save-settings", disabled: !canEdit, onclick: async () => {
        try { await saveAuthSettings(p, { jwt_expiry: Number(expiry.value), password_min_length: Number(minpw.value), disable_signup: disable.checked }); toast("Settings saved", "ok"); } catch (ex) { toast(ex.message, "bad"); }
      } }, "Save")))));
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
  const env = h("textarea", { id: "set-env", class: "code", rows: 4, placeholder: "STRIPE_KEY=…" }, envText);
  clear(body);
  body.append(h("div", { class: "stack" },
    h("div", { class: "card stack" }, h("h3", null, "Function environment"), env, h("p", { class: "muted" }, "One KEY=value per line. Available to functions as environment variables."),
      h("p", { class: "muted" }, "Sign-in settings, such as token lifetime and sign-ups, are under ", h("a", { href: `#/p/${p.ref}/auth/sessions` }, "Authentication"), "."),
      h("div", { class: "row" }, h("button", { class: "primary", id: "save-settings", onclick: async () => {
        try {
          const fe = {};
          for (const line of env.value.split("\n").map((x) => x.trim()).filter(Boolean)) { const i = line.indexOf("="); if (i < 1) throw new Error(`Invalid line: ${line}`); fe[line.slice(0, i)] = line.slice(i + 1); }
          await api("PATCH", `/v1/projects/${p.ref}/settings`, { function_env: fe });
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
  const inv = /^#\/invite\/(baasinv_[A-Za-z0-9_-]+)$/.exec(location.hash);
  if (inv) return renderInvite(inv[1]);
  const rst = /^#\/reset\/(baasrst_[A-Za-z0-9_-]+)$/.exec(location.hash);
  if (rst) return renderReset(rst[1]);
  if (!S.token) {
    S.token = localStorage.getItem("baas.token") || sessionStorage.getItem("baas.token");
    if (S.token) { try { S.me = await api("GET", "/v1/me"); } catch { S.token = null; } }
  }
  if (!S.token) return renderLogin();
  if (!S.config) S.config = await fetch("/v1/config").then((r) => r.json());
  if (!S.me) S.me = await api("GET", "/v1/me");
  const m = /^#\/p\/([a-z0-9]{20})\/([a-z]+)(?:\/([a-z]+))?/.exec(location.hash);
  try {
    if (location.hash === "#/team") { S.project = null; await renderTeam(); }
    else if (m) await renderProject(m[1], m[2], m[3]);
    else { S.project = null; await renderProjects(); }
  } catch (ex) {
    mount(shell(h("div", { class: "notice bad", id: "route-error" }, ex.message), h("p", null, h("a", { href: "#/projects" }, "Back to projects"))));
  }
}

window.addEventListener("hashchange", route);
route();
