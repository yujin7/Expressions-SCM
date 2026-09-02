import { afterEach, describe, expect, it } from "vitest";

import { authCookieConfig } from "../src/server/auth/cookies";

const originalAuthUrl = process.env.AUTH_URL;

afterEach(() => {
  if (originalAuthUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = originalAuthUrl;
});

function request(protocol: string, forwardedProto?: string) {
  const headers = new Headers();
  if (forwardedProto) headers.set("x-forwarded-proto", forwardedProto);
  return { headers, nextUrl: { protocol } };
}

describe("authCookieConfig", () => {
  it("uses the same cookie names for local HTTP and tunneled HTTPS", () => {
    const local = authCookieConfig(request("http:"));
    const tunnel = authCookieConfig(request("https:"));

    expect(local.cookies?.sessionToken?.name).toBe("authjs.session-token");
    expect(tunnel.cookies?.sessionToken?.name).toBe("authjs.session-token");
    expect(local.cookies?.csrfToken?.name).toBe("authjs.csrf-token");
    expect(tunnel.cookies?.csrfToken?.name).toBe("authjs.csrf-token");
  });

  it("keeps tunnel cookies Secure while allowing loopback HTTP", () => {
    expect(authCookieConfig(request("http:")).useSecureCookies).toBe(false);
    expect(authCookieConfig(request("https:")).useSecureCookies).toBe(true);
  });

  it("trusts the proxy protocol before the internal request URL", () => {
    const config = authCookieConfig(request("http:", "https, http"));
    expect(config.useSecureCookies).toBe(true);
    expect(config.cookies?.sessionToken?.options?.secure).toBe(true);
  });

  it("falls back to AUTH_URL when no request is available", () => {
    process.env.AUTH_URL = "https://scm.example.com";
    expect(authCookieConfig().useSecureCookies).toBe(true);
    process.env.AUTH_URL = "http://127.0.0.1:3100";
    expect(authCookieConfig().useSecureCookies).toBe(false);
  });
});
