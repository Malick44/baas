/**
 * Client for one baas project, shaped like supabase-js for the parts this platform implements:
 * auth (password, sessions, refresh), PostgREST-style queries, storage, functions and realtime changes.
 * Works in browsers and Node 22+. No dependencies.
 */

export type ApiError = { message: string; code?: string; details?: string | null; hint?: string | null; status?: number };
export type Result<T> = { data: T | null; error: ApiError | null; status: number; count?: number | null };

export type Session = { access_token: string; refresh_token: string; expires_at: number; expires_in: number; token_type: string; user: User };
export type User = { id: string; email: string | null; app_metadata: Record<string, unknown>; user_metadata: Record<string, unknown>; [k: string]: unknown };

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
export type ClientOptions = {
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => WebSocket;
  /** Where to keep the session; defaults to memory. Pass localStorage in a browser. */
  storage?: KV;
  autoRefreshToken?: boolean;
};

type AuthEvent = "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "USER_UPDATED";

const quote = (v: unknown) => {
  const s = String(v);
  return /[,()"\\]/.test(s) || s === "" ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s;
};

export function createClient(url: string, key: string, opts: ClientOptions = {}) {
  const base = url.replace(/\/+$/, "");
  const doFetch: typeof fetch = opts.fetch ?? ((...a) => fetch(...a));
  const mem = new Map<string, string>();
  const store: KV = opts.storage ?? { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  const SKEY = `baas.auth.${new URL(base).host}`;
  const listeners = new Set<(e: AuthEvent, s: Session | null) => void>();
  let session: Session | null = (() => {
    try {
      const raw = store.getItem(SKEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  })();
  let refreshing: Promise<Result<Session>> | null = null;

  const err = (status: number, body: any, fallback: string): ApiError => ({
    message: body?.message ?? body?.msg ?? body?.error ?? fallback, code: body?.error_code ?? body?.code, details: body?.details ?? null, hint: body?.hint ?? null, status,
  });

  async function parse(res: Response): Promise<any> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function setSession(s: Session | null, ev: AuthEvent) {
    session = s;
    try {
      if (s) store.setItem(SKEY, JSON.stringify(s));
      else store.removeItem(SKEY);
    } catch {
      /* storage unavailable */
    }
    for (const l of listeners) l(ev, s);
    realtime.setToken(s?.access_token ?? null);
  }

  async function token(): Promise<string> {
    if (session && opts.autoRefreshToken !== false && session.expires_at - Date.now() / 1000 < 30) await auth.refreshSession();
    return session?.access_token ?? key;
  }

  async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { apikey: key, authorization: `Bearer ${await token()}`, ...extra };
  }

  // ---- auth ----
  const authCall = async (path: string, init: RequestInit = {}) => {
    const res = await doFetch(`${base}/auth/v1${path}`, { ...init, headers: { apikey: key, "content-type": "application/json", ...(init.headers as object) } });
    return { res, body: await parse(res) };
  };

  const auth = {
    /** Resolves with a session, or with just the user when the project wants the email address confirmed first. */
    async signUp(c: { email: string; password: string; options?: { data?: object; emailRedirectTo?: string } }): Promise<Result<{ user: User | null; session: Session | null }>> {
      const q = c.options?.emailRedirectTo ? `?redirect_to=${encodeURIComponent(c.options.emailRedirectTo)}` : "";
      const { res, body } = await authCall(`/signup${q}`, { method: "POST", body: JSON.stringify({ email: c.email, password: c.password, data: c.options?.data }) });
      if (!res.ok) return { data: null, error: err(res.status, body, "sign up failed"), status: res.status };
      if (!body?.access_token) return { data: { user: body as User, session: null }, error: null, status: res.status };
      setSession(body as Session, "SIGNED_IN");
      return { data: { user: body.user, session: body }, error: null, status: res.status };
    },
    /** Email the user a link to choose a new password. The link ends on redirectTo with a recovery session in the URL fragment. */
    async resetPasswordForEmail(email: string, o: { redirectTo?: string } = {}): Promise<Result<{}>> {
      const q = o.redirectTo ? `?redirect_to=${encodeURIComponent(o.redirectTo)}` : "";
      const { res, body } = await authCall(`/recover${q}`, { method: "POST", body: JSON.stringify({ email }) });
      return res.ok ? { data: {}, error: null, status: res.status } : { data: null, error: err(res.status, body, "could not send the email"), status: res.status };
    },
    /** Email a sign-in link. Creates the account on first use unless shouldCreateUser is false. */
    async signInWithOtp(c: { email: string; options?: { emailRedirectTo?: string; shouldCreateUser?: boolean; data?: object } }): Promise<Result<{}>> {
      const q = c.options?.emailRedirectTo ? `?redirect_to=${encodeURIComponent(c.options.emailRedirectTo)}` : "";
      const { res, body } = await authCall(`/magiclink${q}`, { method: "POST", body: JSON.stringify({ email: c.email, create_user: c.options?.shouldCreateUser, data: c.options?.data }) });
      return res.ok ? { data: {}, error: null, status: res.status } : { data: null, error: err(res.status, body, "could not send the email"), status: res.status };
    },
    /** Trade the token from an email link for a session (for apps that handle the link themselves). */
    async verifyOtp(c: { type: "signup" | "recovery" | "magiclink" | "email"; token: string }): Promise<Result<{ user: User; session: Session }>> {
      const { res, body } = await authCall("/verify", { method: "POST", body: JSON.stringify({ type: c.type, token: c.token }) });
      if (!res.ok) return { data: null, error: err(res.status, body, "verification failed"), status: res.status };
      setSession(body as Session, "SIGNED_IN");
      return { data: { user: body.user, session: body }, error: null, status: res.status };
    },
    async resend(c: { type: "signup"; email: string; options?: { emailRedirectTo?: string } }): Promise<Result<{}>> {
      const q = c.options?.emailRedirectTo ? `?redirect_to=${encodeURIComponent(c.options.emailRedirectTo)}` : "";
      const { res, body } = await authCall(`/resend${q}`, { method: "POST", body: JSON.stringify({ type: c.type, email: c.email }) });
      return res.ok ? { data: {}, error: null, status: res.status } : { data: null, error: err(res.status, body, "could not send the email"), status: res.status };
    },
    /** The address to send the browser to for "Sign in with …". In a browser it goes there unless skipBrowserRedirect is set. */
    async signInWithOAuth(c: { provider: string; options?: { redirectTo?: string; skipBrowserRedirect?: boolean } }): Promise<Result<{ provider: string; url: string }>> {
      const url = `${base}/auth/v1/authorize?provider=${encodeURIComponent(c.provider)}${c.options?.redirectTo ? `&redirect_to=${encodeURIComponent(c.options.redirectTo)}` : ""}`;
      const w = (globalThis as { location?: { assign(u: string): void } }).location;
      if (w && c.options?.skipBrowserRedirect !== true) w.assign(url);
      return { data: { provider: c.provider, url }, error: null, status: 200 };
    },
    /**
     * Read the session an email link or provider put in the URL fragment (call it on the page you redirected to) and sign in with it.
     * Returns the error from the fragment instead when the sign-in failed.
     */
    async getSessionFromUrl(href?: string): Promise<Result<{ session: Session; type: string }>> {
      const u = new URL(href ?? (globalThis as { location?: { href: string } }).location?.href ?? "");
      const f = new URLSearchParams(u.hash.replace(/^#/, ""));
      if (f.get("error")) return { data: null, error: { message: f.get("error_description") ?? f.get("error")!, code: f.get("error_code") ?? f.get("error")! }, status: 400 };
      const access = f.get("access_token"), refresh = f.get("refresh_token");
      if (!access || !refresh) return { data: null, error: { message: "no session in the URL" }, status: 400 };
      const { res, body } = await authCall("/user", { headers: { authorization: `Bearer ${access}` } });
      if (!res.ok) return { data: null, error: err(res.status, body, "could not read the user"), status: res.status };
      const s: Session = { access_token: access, refresh_token: refresh, expires_at: Number(f.get("expires_at")), expires_in: Number(f.get("expires_in")), token_type: "bearer", user: body };
      setSession(s, "SIGNED_IN");
      return { data: { session: s, type: f.get("type") ?? "" }, error: null, status: 200 };
    },
    async signInWithPassword(c: { email: string; password: string }): Promise<Result<{ user: User; session: Session }>> {
      const { res, body } = await authCall("/token?grant_type=password", { method: "POST", body: JSON.stringify(c) });
      if (!res.ok) return { data: null, error: err(res.status, body, "sign in failed"), status: res.status };
      setSession(body as Session, "SIGNED_IN");
      return { data: { user: body.user, session: body }, error: null, status: res.status };
    },
    async refreshSession(): Promise<Result<Session>> {
      if (!session) return { data: null, error: { message: "no session" }, status: 401 };
      refreshing ??= (async () => {
        const { res, body } = await authCall("/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: session!.refresh_token }) });
        if (!res.ok) {
          setSession(null, "SIGNED_OUT");
          return { data: null, error: err(res.status, body, "refresh failed"), status: res.status } as Result<Session>;
        }
        setSession(body as Session, "TOKEN_REFRESHED");
        return { data: body as Session, error: null, status: res.status } as Result<Session>;
      })().finally(() => (refreshing = null));
      return refreshing;
    },
    async getSession(): Promise<Result<{ session: Session | null }>> {
      if (session && session.expires_at - Date.now() / 1000 < 30) await auth.refreshSession();
      return { data: { session }, error: null, status: 200 };
    },
    async getUser(): Promise<Result<{ user: User }>> {
      if (!session) return { data: null, error: { message: "Auth session missing" }, status: 401 };
      const { res, body } = await authCall("/user", { headers: { authorization: `Bearer ${await token()}` } });
      return res.ok ? { data: { user: body }, error: null, status: res.status } : { data: null, error: err(res.status, body, "get user failed"), status: res.status };
    },
    async updateUser(attrs: { email?: string; password?: string; data?: object }): Promise<Result<{ user: User }>> {
      if (!session) return { data: null, error: { message: "Auth session missing" }, status: 401 };
      const { res, body } = await authCall("/user", { method: "PUT", body: JSON.stringify(attrs), headers: { authorization: `Bearer ${await token()}` } });
      if (!res.ok) return { data: null, error: err(res.status, body, "update failed"), status: res.status };
      setSession({ ...session, user: body }, "USER_UPDATED");
      return { data: { user: body }, error: null, status: res.status };
    },
    async signOut(): Promise<{ error: ApiError | null }> {
      if (session) await authCall("/logout", { method: "POST", headers: { authorization: `Bearer ${session.access_token}` } }).catch(() => {});
      setSession(null, "SIGNED_OUT");
      return { error: null };
    },
    onAuthStateChange(cb: (e: AuthEvent, s: Session | null) => void) {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => void listeners.delete(cb) } } };
    },
  };

  // ---- queries ----
  class Query<T = any> implements PromiseLike<Result<T>> {
    private params: [string, string][] = [];
    private prefer: string[] = [];
    private hdr: Record<string, string> = {};
    private body: unknown;
    private wantOne: "single" | "maybe" | null = null;
    private method = "GET";
    private wantsRows = false;

    constructor(private path: string) {}

    private add(k: string, v: string) {
      this.params.push([k, v]);
      return this;
    }

    select(cols = "*", o: { count?: "exact" } = {}) {
      this.add("select", cols.replace(/\s+/g, ""));
      if (o.count) this.prefer.push(`count=${o.count}`);
      if (this.method !== "GET") this.prefer.push("return=representation");
      this.wantsRows = true;
      return this;
    }
    insert(values: object | object[], o: { count?: "exact" } = {}) {
      this.method = "POST";
      this.body = values;
      if (o.count) this.prefer.push(`count=${o.count}`);
      return this;
    }
    upsert(values: object | object[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
      this.method = "POST";
      this.body = values;
      this.prefer.push(`resolution=${o.ignoreDuplicates ? "ignore" : "merge"}-duplicates`);
      if (o.onConflict) this.add("on_conflict", o.onConflict);
      return this;
    }
    update(values: object) {
      this.method = "PATCH";
      this.body = values;
      return this;
    }
    delete() {
      this.method = "DELETE";
      return this;
    }

    eq = (c: string, v: unknown) => this.add(c, `eq.${v}`);
    neq = (c: string, v: unknown) => this.add(c, `neq.${v}`);
    gt = (c: string, v: unknown) => this.add(c, `gt.${v}`);
    gte = (c: string, v: unknown) => this.add(c, `gte.${v}`);
    lt = (c: string, v: unknown) => this.add(c, `lt.${v}`);
    lte = (c: string, v: unknown) => this.add(c, `lte.${v}`);
    like = (c: string, v: string) => this.add(c, `like.${v}`);
    ilike = (c: string, v: string) => this.add(c, `ilike.${v}`);
    is = (c: string, v: null | boolean) => this.add(c, `is.${v}`);
    in = (c: string, vs: unknown[]) => this.add(c, `in.(${vs.map(quote).join(",")})`);
    not = (c: string, op: string, v: unknown) => this.add(c, `not.${op}.${Array.isArray(v) ? `(${v.map(quote).join(",")})` : v}`);
    or = (expr: string) => this.add("or", `(${expr})`);
    filter = (c: string, op: string, v: unknown) => this.add(c, `${op}.${v}`);
    match(obj: Record<string, unknown>) {
      for (const [k, v] of Object.entries(obj)) this.eq(k, v);
      return this;
    }

    order(c: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
      const cur = this.params.find(([k]) => k === "order");
      const part = `${c}.${o.ascending === false ? "desc" : "asc"}${o.nullsFirst === undefined ? "" : o.nullsFirst ? ".nullsfirst" : ".nullslast"}`;
      if (cur) cur[1] += `,${part}`;
      else this.add("order", part);
      return this;
    }
    limit(n: number) {
      return this.add("limit", String(n));
    }
    range(from: number, to: number) {
      this.add("offset", String(from));
      return this.add("limit", String(to - from + 1));
    }
    single<U = T extends Array<infer E> ? E : T>(): Query<U> {
      this.wantOne = "single";
      return this as unknown as Query<U>;
    }
    maybeSingle<U = T extends Array<infer E> ? E : T>(): Query<U> {
      this.wantOne = "maybe";
      return this as unknown as Query<U>;
    }

    async run(): Promise<Result<T>> {
      const h: Record<string, string> = { ...this.hdr };
      const prefer = [...this.prefer];
      if (this.method !== "GET" && !this.wantsRows && !prefer.some((p) => p.startsWith("return="))) prefer.push("return=minimal");
      if (prefer.length) h.prefer = prefer.join(",");
      if (this.wantOne) h.accept = "application/vnd.pgrst.object+json";
      if (this.body !== undefined) h["content-type"] = "application/json";
      const q = new URLSearchParams(this.params).toString();
      const res = await doFetch(`${base}/rest/v1/${this.path}${q ? `?${q}` : ""}`, {
        method: this.method, headers: await headers(h), body: this.body === undefined ? undefined : JSON.stringify(this.body),
      });
      const body = await parse(res);
      if (this.wantOne === "maybe" && res.status === 406) return { data: null, error: null, status: 200 };
      if (!res.ok) return { data: null, error: err(res.status, body, res.statusText), status: res.status };
      const range = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
      return { data: (body ?? null) as T, error: null, status: res.status, count: range ? Number(range[1]) : null };
    }
    then<A = Result<T>, B = never>(ok?: ((v: Result<T>) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
      return this.run().then(ok, bad);
    }
  }

  // ---- storage ----
  const storageFetch = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const h = await headers(init.json !== undefined ? { "content-type": "application/json" } : {});
    const res = await doFetch(`${base}/storage/v1${path}`, { ...init, headers: { ...h, ...(init.headers as object) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    return res;
  };
  const wrap = async <T>(res: Response, pick: (b: any) => T): Promise<Result<T>> => {
    const body = await parse(res);
    return res.ok ? { data: pick(body), error: null, status: res.status } : { data: null, error: err(res.status, body, res.statusText), status: res.status };
  };
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

  const storage = {
    createBucket: async (id: string, o: { public?: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] } = {}) =>
      wrap(await storageFetch("/bucket", { method: "POST", json: { id, public: o.public, file_size_limit: o.fileSizeLimit, allowed_mime_types: o.allowedMimeTypes } }), (b) => b),
    listBuckets: async () => wrap(await storageFetch("/bucket"), (b) => b as any[]),
    deleteBucket: async (id: string) => wrap(await storageFetch(`/bucket/${encodeURIComponent(id)}`, { method: "DELETE" }), (b) => b),
    from(bucket: string) {
      const b = encodeURIComponent(bucket);
      return {
        async upload(path: string, body: string | Blob | ArrayBuffer | Uint8Array, o: { contentType?: string; upsert?: boolean } = {}) {
          const ct = o.contentType ?? (body instanceof Blob && body.type ? body.type : typeof body === "string" ? "text/plain" : "application/octet-stream");
          return wrap(await storageFetch(`/object/${b}/${enc(path)}`, { method: "POST", body: body as BodyInit, headers: { "content-type": ct, "x-upsert": String(!!o.upsert) } }), (x) => ({ path, id: x.Id, fullPath: x.Key }));
        },
        async download(path: string): Promise<Result<Blob>> {
          const res = await storageFetch(`/object/authenticated/${b}/${enc(path)}`);
          return res.ok ? { data: await res.blob(), error: null, status: res.status } : { data: null, error: err(res.status, await parse(res), res.statusText), status: res.status };
        },
        list: async (prefix = "", o: { limit?: number; offset?: number; search?: string } = {}) => wrap(await storageFetch(`/object/list/${b}`, { method: "POST", json: { prefix, ...o } }), (x) => x as any[]),
        remove: async (paths: string[]) => wrap(await storageFetch(`/object/${b}`, { method: "DELETE", json: { prefixes: paths } }), (x) => x as any[]),
        move: async (from: string, to: string) => wrap(await storageFetch("/object/move", { method: "POST", json: { bucketId: bucket, sourceKey: from, destinationKey: to } }), (x) => x),
        copy: async (from: string, to: string) => wrap(await storageFetch("/object/copy", { method: "POST", json: { bucketId: bucket, sourceKey: from, destinationKey: to } }), (x) => x),
        createSignedUrl: async (path: string, expiresIn: number) =>
          wrap(await storageFetch(`/object/sign/${b}/${enc(path)}`, { method: "POST", json: { expiresIn } }), (x) => ({ signedUrl: `${base}/storage/v1${x.signedURL}` })),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `${base}/storage/v1/object/public/${b}/${enc(path)}` } }),
      };
    },
  };

  // ---- functions ----
  const functions = {
    async invoke<T = any>(name: string, o: { body?: unknown; headers?: Record<string, string>; method?: string } = {}): Promise<Result<T>> {
      const isJson = o.body !== undefined && o.body !== null && typeof o.body === "object" && !(o.body instanceof Blob) && !(o.body instanceof ArrayBuffer) && !ArrayBuffer.isView(o.body);
      const res = await doFetch(`${base}/functions/v1/${encodeURIComponent(name)}`, {
        method: o.method ?? "POST",
        headers: await headers({ ...(isJson ? { "content-type": "application/json" } : {}), ...o.headers }),
        body: o.body === undefined ? undefined : isJson ? JSON.stringify(o.body) : (o.body as BodyInit),
      });
      const body = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => null) : await res.text();
      return res.ok ? { data: body as T, error: null, status: res.status } : { data: null, error: err(res.status, body, "function error"), status: res.status };
    },
  };

  // ---- realtime ----
  type Handler = { event: string; schema?: string; table: string; filter?: string; cb: (p: any) => void; ref: string };
  const realtime = (() => {
    let ws: WebSocket | null = null;
    let open = false;
    let closedByUs = false;
    let attempt = 0;
    let n = 0;
    const channels = new Set<Channel>();
    const queue: string[] = [];

    const send = (m: object) => {
      const s = JSON.stringify(m);
      if (ws && open) ws.send(s);
      else queue.push(s);
    };
    const connect = () => {
      const WS = opts.WebSocket ?? (globalThis as any).WebSocket;
      if (!WS) throw new Error("no WebSocket implementation: pass one in options");
      const u = new URL(base);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/realtime/v1/websocket";
      u.search = `apikey=${encodeURIComponent(key)}`;
      const sock: WebSocket = new WS(u.toString());
      ws = sock;
      sock.onopen = () => {
        open = true;
        attempt = 0;
        if (session) sock.send(JSON.stringify({ type: "access_token", token: session.access_token }));
        for (const c of channels) c.resubscribe();
        for (const m of queue.splice(0)) sock.send(m);
      };
      sock.onmessage = (e: MessageEvent) => {
        let m: any;
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        for (const c of channels) c.deliver(m);
      };
      sock.onclose = () => {
        open = false;
        ws = null;
        for (const c of channels) c.status("CLOSED");
        if (!closedByUs && channels.size) setTimeout(connect, Math.min(30_000, 500 * 2 ** attempt++));
      };
      sock.onerror = () => {};
    };

    class Channel {
      handlers: Handler[] = [];
      private cbStatus?: (s: string) => void;
      constructor(readonly name: string) {}
      on(_type: "postgres_changes", f: { event: string; schema?: string; table: string; filter?: string }, cb: (p: any) => void) {
        this.handlers.push({ ...f, cb, ref: `${this.name}:${++n}` });
        return this;
      }
      subscribe(cb?: (s: string) => void) {
        this.cbStatus = cb;
        channels.add(this);
        closedByUs = false;
        if (!ws) connect();
        else if (open) this.resubscribe();
        return this;
      }
      resubscribe() {
        for (const h of this.handlers) send({ type: "subscribe", ref: h.ref, table: h.table, event: h.event, filter: h.filter });
      }
      status(s: string) {
        this.cbStatus?.(s);
      }
      deliver(m: any) {
        const h = this.handlers.find((x) => x.ref === m.ref);
        if (!h) return;
        if (m.type === "subscribed") this.status("SUBSCRIBED");
        else if (m.type === "error") this.status("CHANNEL_ERROR");
        else if (m.type === "change") h.cb({ schema: m.schema, table: m.table, eventType: m.event, new: m.new ?? {}, old: m.old ?? {}, errors: null });
      }
      unsubscribe() {
        for (const h of this.handlers) send({ type: "unsubscribe", ref: h.ref });
        channels.delete(this);
        if (!channels.size) {
          closedByUs = true;
          ws?.close();
        }
      }
    }
    return {
      channel: (name: string) => new Channel(name),
      setToken: (t: string | null) => {
        if (t && ws && open) ws.send(JSON.stringify({ type: "access_token", token: t }));
      },
      removeAll: () => [...channels].forEach((c) => c.unsubscribe()),
    };
  })();

  return {
    auth,
    from: <T = any>(table: string) => ({
      select: (cols?: string, o?: { count?: "exact" }) => new Query<T[]>(table).select(cols, o),
      insert: (v: object | object[], o?: { count?: "exact" }) => new Query<T[]>(table).insert(v, o),
      upsert: (v: object | object[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => new Query<T[]>(table).upsert(v, o),
      update: (v: object) => new Query<T[]>(table).update(v),
      delete: () => new Query<T[]>(table).delete(),
    }),
    rpc: async <T = any>(fn: string, args: object = {}, o: { get?: boolean } = {}): Promise<Result<T>> => {
      const q = o.get ? `?${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]))}` : "";
      const res = await doFetch(`${base}/rest/v1/rpc/${encodeURIComponent(fn)}${q}`, {
        method: o.get ? "GET" : "POST", headers: await headers(o.get ? {} : { "content-type": "application/json" }), body: o.get ? undefined : JSON.stringify(args),
      });
      const body = await parse(res);
      return res.ok ? { data: body as T, error: null, status: res.status } : { data: null, error: err(res.status, body, res.statusText), status: res.status };
    },
    storage,
    functions,
    channel: realtime.channel,
    removeAllChannels: realtime.removeAll,
    removeChannel: (c: { unsubscribe(): void }) => c.unsubscribe(),
  };
}

export type BaasClient = ReturnType<typeof createClient>;
