import type { NextAuthConfig } from "next-auth";

type AuthRequestOrigin = {
  headers: Pick<Headers, "get">;
  nextUrl?: { protocol?: string };
};

function normalizedProtocol(value: string | null | undefined): "http" | "https" | undefined {
  const protocol = value?.split(",", 1)[0]?.trim().replace(/:$/, "").toLowerCase();
  return protocol === "http" || protocol === "https" ? protocol : undefined;
}

/**
 * Loopback HTTP and the Cloudflare HTTPS tunnel share one deployment. Cookie names must stay
 * stable across origins; Secure follows the actual request, not the global AUTH_URL alone.
 * The trusted reverse proxy must overwrite x-forwarded-proto (the same trustHost boundary
 * used by Auth.js). Middleware only reads the session token and never writes Cookie attributes.
 */
export function authCookieConfig(
  request?: AuthRequestOrigin,
): Pick<NextAuthConfig, "cookies" | "useSecureCookies"> {
  const forwardedProtocol = normalizedProtocol(request?.headers.get("x-forwarded-proto"));
  const requestProtocol = normalizedProtocol(request?.nextUrl?.protocol);
  const configuredProtocol = normalizedProtocol(process.env.AUTH_URL?.split(":", 1)[0]);
  const secure = (forwardedProtocol ?? requestProtocol ?? configuredProtocol) === "https";
  const common = { httpOnly: true, sameSite: "lax" as const, path: "/", secure };
  const transient = { ...common, maxAge: 15 * 60 };

  return {
    useSecureCookies: secure,
    cookies: {
      sessionToken: { name: "authjs.session-token", options: common },
      callbackUrl: { name: "authjs.callback-url", options: common },
      csrfToken: { name: "authjs.csrf-token", options: common },
      pkceCodeVerifier: { name: "authjs.pkce.code_verifier", options: transient },
      state: { name: "authjs.state", options: transient },
      nonce: { name: "authjs.nonce", options: common },
      webauthnChallenge: { name: "authjs.challenge", options: transient },
    },
  };
}
