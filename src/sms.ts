/** Sends text messages for phone sign-in. Like the mailer, it is switched off until the operator configures a provider. */
export type Sms = { to: string; body: string };

export interface SmsSender {
  /** False when no provider is set up; phone sign-in then answers 501. */
  readonly configured: boolean;
  send(sms: Sms): Promise<void>;
}

export class NoSms implements SmsSender {
  readonly configured = false;
  async send(): Promise<void> {
    throw new Error("text messages are not configured");
  }
}

/** Keeps messages in memory. For tests and local development. */
export class MemorySms implements SmsSender {
  readonly configured = true;
  outbox: Sms[] = [];
  async send(sms: Sms): Promise<void> {
    this.outbox.push(sms);
  }
  last(to?: string): Sms | undefined {
    return [...this.outbox].reverse().find((m) => !to || m.to === to);
  }
}

export type TwilioConfig = { accountSid: string; authToken: string; /** A sending number, or a messaging service SID (starting MG). */ from: string; baseUrl?: string; fetch?: typeof fetch };

/** Twilio's Messages API. */
export class TwilioSms implements SmsSender {
  readonly configured = true;
  constructor(private cfg: TwilioConfig) {
    if (!/^AC[0-9a-f]{32}$/i.test(cfg.accountSid)) throw new Error("TWILIO_ACCOUNT_SID looks wrong (it starts with AC)");
  }
  async send(sms: Sms): Promise<void> {
    const f = this.cfg.fetch ?? fetch;
    const form = new URLSearchParams({ To: sms.to, Body: sms.body });
    form.set(/^MG[0-9a-f]{32}$/i.test(this.cfg.from) ? "MessagingServiceSid" : "From", this.cfg.from);
    const res = await f(`${this.cfg.baseUrl ?? "https://api.twilio.com"}/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: form, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { message?: string; code?: number };
      throw new Error(`Twilio answered ${res.status}${j.message ? `: ${j.message}` : ""}`);
    }
  }
}

export function smsFrom(cfg?: { sender?: SmsSender; twilio?: TwilioConfig }): SmsSender {
  if (cfg?.sender) return cfg.sender;
  if (cfg?.twilio) return new TwilioSms(cfg.twilio);
  return new NoSms();
}
