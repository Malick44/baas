import { createTransport, type Transporter } from "nodemailer";

export type Mail = { to: string; subject: string; text: string; html?: string; fromName?: string };

/** Sends the platform's own messages (confirmation, password reset, magic link). */
export interface Mailer {
  /** False when the operator has not set up email delivery; flows that need email are then switched off. */
  readonly configured: boolean;
  send(mail: Mail): Promise<void>;
}

export class NoMailer implements Mailer {
  readonly configured = false;
  async send(): Promise<void> {
    throw new Error("email delivery is not configured");
  }
}

/** Keeps messages in memory. For tests and local development. */
export class MemoryMailer implements Mailer {
  readonly configured = true;
  outbox: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.outbox.push(mail);
  }
  last(to?: string): Mail | undefined {
    return [...this.outbox].reverse().find((m) => !to || m.to === to);
  }
}

/** Delivers through any SMTP server, e.g. smtps://user:pass@smtp.example.com:465. */
export class SmtpMailer implements Mailer {
  readonly configured = true;
  private transport: Transporter;
  constructor(url: string, private from: string) {
    this.transport = createTransport({ url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  }
  async send(m: Mail): Promise<void> {
    const address = /<([^>]+)>/.exec(this.from)?.[1] ?? this.from;
    await this.transport.sendMail({ from: m.fromName ? { name: m.fromName.replace(/[\r\n"<>]/g, ""), address } : this.from, to: m.to, subject: m.subject.replace(/[\r\n]/g, " "), text: m.text, html: m.html });
  }
}

export function mailerFrom(cfg?: { smtpUrl?: string; from?: string; mailer?: Mailer }): Mailer {
  if (cfg?.mailer) return cfg.mailer;
  if (cfg?.smtpUrl) return new SmtpMailer(cfg.smtpUrl, cfg.from ?? "baas <no-reply@localhost>");
  return new NoMailer();
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A plain-text body as simple HTML: paragraphs, with web addresses made clickable. */
export function htmlFromText(text: string): string {
  const paras = text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>")}</p>`);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">${paras.join("")}</body></html>`;
}

export type TemplateKind = "confirmation" | "recovery" | "magic_link";
export const DEFAULT_TEMPLATES: Record<TemplateKind, { subject: string; body: string }> = {
  confirmation: { subject: "Confirm your email address", body: "Hello,\n\nFollow this link to confirm your email address ({{ .Email }}):\n\n{{ .ConfirmationURL }}\n\nOr enter this code in the app: {{ .Token }}\n\nIf you did not sign up, you can ignore this message." },
  recovery: { subject: "Reset your password", body: "Hello,\n\nFollow this link to choose a new password for {{ .Email }}:\n\n{{ .ConfirmationURL }}\n\nOr enter this code in the app: {{ .Token }}\n\nIf you did not ask for this, you can ignore this message. Your password stays the same." },
  magic_link: { subject: "Your sign-in link", body: "Hello,\n\nFollow this link to sign in as {{ .Email }}:\n\n{{ .ConfirmationURL }}\n\nOr enter this code in the app: {{ .Token }}\n\nIf you did not ask for this, you can ignore this message." },
};

/** Fill {{ .Name }} placeholders. Only the variables below exist; anything else becomes empty. */
export function renderTemplate(text: string, vars: { ConfirmationURL: string; Email: string; SiteURL: string; Token: string }): string {
  return text.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_m, k: string) => (vars as Record<string, string>)[k] ?? "");
}
