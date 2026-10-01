/**
 * "Sign in with …" providers. Each one is the standard authorization-code flow; this table says where to send the user,
 * where to trade the code for a token, and how to read the profile that comes back.
 */
export type Profile = { id: string; email: string | null; emailVerified: boolean; name?: string; avatar?: string; raw: Record<string, unknown> };

export type OAuthProvider = {
  label: string;
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  scopes: string;
  /** Send a PKCE challenge. Left off for providers that do not support it. */
  pkce: boolean;
  /** Extra request after the profile (GitHub keeps verified emails on a separate endpoint). */
  emailsUrl?: string;
  profile(user: Record<string, any>, emails?: Array<Record<string, any>>): Profile;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export const PROVIDERS: Record<string, OAuthProvider> = {
  google: {
    label: "Google", pkce: true, scopes: "openid email profile",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    profile: (u) => ({ id: String(u.sub ?? ""), email: str(u.email) ?? null, emailVerified: u.email_verified === true, name: str(u.name), avatar: str(u.picture), raw: u }),
  },
  github: {
    label: "GitHub", pkce: false, scopes: "read:user user:email",
    authUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token", userUrl: "https://api.github.com/user", emailsUrl: "https://api.github.com/user/emails",
    profile(u, emails) {
      const primary = (emails ?? []).find((e) => e.primary && e.verified) ?? (emails ?? []).find((e) => e.verified);
      return { id: String(u.id ?? ""), email: str(primary?.email) ?? null, emailVerified: !!primary, name: str(u.name) ?? str(u.login), avatar: str(u.avatar_url), raw: u };
    },
  },
  gitlab: {
    label: "GitLab", pkce: true, scopes: "read_user openid email",
    authUrl: "https://gitlab.com/oauth/authorize", tokenUrl: "https://gitlab.com/oauth/token", userUrl: "https://gitlab.com/api/v4/user",
    profile: (u) => ({ id: String(u.id ?? ""), email: str(u.email) ?? null, emailVerified: !!str(u.confirmed_at), name: str(u.name) ?? str(u.username), avatar: str(u.avatar_url), raw: u }),
  },
  discord: {
    label: "Discord", pkce: true, scopes: "identify email",
    authUrl: "https://discord.com/oauth2/authorize", tokenUrl: "https://discord.com/api/oauth2/token", userUrl: "https://discord.com/api/users/@me",
    profile: (u) => ({ id: String(u.id ?? ""), email: str(u.email) ?? null, emailVerified: u.verified === true, name: str(u.global_name) ?? str(u.username),
      avatar: u.avatar && u.id ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : undefined, raw: u }),
  },
  microsoft: {
    label: "Microsoft", pkce: true, scopes: "openid email profile User.Read",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token", userUrl: "https://graph.microsoft.com/oidc/userinfo",
    // Microsoft does not say whether an address is verified, so it is never trusted to link to an existing account.
    profile: (u) => ({ id: String(u.sub ?? ""), email: str(u.email) ?? null, emailVerified: false, name: str(u.name), raw: u }),
  },
};

export type ProviderName = keyof typeof PROVIDERS;
export const isProvider = (n: unknown): n is string => typeof n === "string" && Object.hasOwn(PROVIDERS, n);
