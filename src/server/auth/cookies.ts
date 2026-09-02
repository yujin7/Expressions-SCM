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
 * This deployment is reachable through both loopback HTTP and a Cloudflare HTTPS tunnel.
 * Auth.js normally changes both cookie security and cookie names based on one AUTH_URL, which
 * makes the other origin unable to log in. Names stay stable while HTTPS requests remain Secure.
 */
export function authCookieConfig(
  request?: AuthRequestOrigin,
): Pick<NextAuthConfig, "cookies" | "useSecureCookies"> {
  const forwardedProtocol = normalizedProtocol(request?.headers.get("x-forwarded-proto"));
  const requestProtocol = normalizedProtocol(request?.nextUrl?.protocol);
  const configuredProtocol = normalizedProtocol(process.env.AUTH_URL?.split(":", 1)[0]);
  const secure = (forwardedProtocol ?? requestProtocol ?? configuredProtocol) === "https";
  const common = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
  };
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
