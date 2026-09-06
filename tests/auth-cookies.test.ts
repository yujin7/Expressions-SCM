import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Match the existing auth test harness: Auth.js's external ESM entry imports extensionless
// next/server under Node. Stub only provider construction; the real application cookie policy,
// request wrapper and D62 callbacks below remain under test, without starting Auth.js or a DB.
vi.mock("next-auth", () => ({
  CredentialsSignin: class extends Error {
    code = "";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (config: unknown) => config }));

import { authCookieConfig } from "../src/server/auth/cookies";
import { authConfig, authConfigForRequest } from "../src/server/auth/config";

const originalAuthUrl = process.env.AUTH_URL;

afterEach(() => {
  if (originalAuthUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = originalAuthUrl;
});

function request(protocol: string, forwardedProto?: string) {
  const headers = new Headers();
  if (forwardedProto !== undefined) headers.set("x-forwarded-proto", forwardedProto);
  return { headers, nextUrl: { protocol } };
}

describe("dual-origin auth cookies", () => {
  it("uses stable host-only cookie names on HTTP and HTTPS", () => {
    const local = authCookieConfig(request("http:"));
    const tunnel = authCookieConfig(request("https:"));
    expect(local.cookies?.sessionToken?.name).toBe("authjs.session-token");
    expect(local.cookies?.csrfToken?.name).toBe("authjs.csrf-token");
    for (const [key, cookie] of Object.entries(local.cookies ?? {})) {
      const publicCookie = tunnel.cookies?.[key as keyof NonNullable<typeof tunnel.cookies>];
      expect(publicCookie?.name).toBe(cookie?.name);
      expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: false });
      expect(publicCookie?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: true });
      expect(cookie?.options).not.toHaveProperty("domain");
      expect(publicCookie?.options).not.toHaveProperty("domain");
    }
    expect(tunnel.cookies?.state?.options?.maxAge).toBe(900);
    expect(tunnel.cookies?.pkceCodeVerifier?.options?.maxAge).toBe(900);
  });

  it("honors actual local HTTP even when AUTH_URL is the public HTTPS tunnel", () => {
    process.env.AUTH_URL = "https://scm.example.com";
    expect(authCookieConfig(request("http:")).useSecureCookies).toBe(false);
  });

  it("keeps direct HTTPS secure even when AUTH_URL is local HTTP", () => {
    process.env.AUTH_URL = "http://127.0.0.1:3100";
    expect(authCookieConfig(request("https:")).useSecureCookies).toBe(true);
  });

  it("uses the trusted proxy's first protocol before the internal request URL", () => {
    process.env.AUTH_URL = "http://127.0.0.1:3100";
    expect(authCookieConfig(request("http:", " HTTPS, http ")).useSecureCookies).toBe(true);
    expect(authCookieConfig(request("https:", "http, https")).useSecureCookies).toBe(false);
  });

  it.each(["", "ftp", "invalid, https"])("ignores malformed proxy protocol %j", (protocol) => {
    process.env.AUTH_URL = "http://127.0.0.1:3100";
    expect(authCookieConfig(request("https:", protocol)).useSecureCookies).toBe(true);
  });

  it("uses AUTH_URL only when no valid request protocol is available", () => {
    process.env.AUTH_URL = "https://scm.example.com";
    expect(authCookieConfig().useSecureCookies).toBe(true);
    expect(authCookieConfig(request("invalid:", "ftp")).useSecureCookies).toBe(true);
    process.env.AUTH_URL = "http://127.0.0.1:3100";
    expect(authCookieConfig().useSecureCookies).toBe(false);
  });

  it("wraps the current policy without dropping D62 callbacks, providers or session expiry", () => {
    process.env.AUTH_URL = "https://scm.example.com";
    const local = authConfigForRequest(new NextRequest("http://127.0.0.1:3100/api/auth/session"));
    const tunnel = authConfigForRequest(new NextRequest("http://localhost:3000/api/auth/session", {
      headers: { "x-forwarded-proto": "https" },
    }));
    expect(local.useSecureCookies).toBe(false);
    expect(tunnel.useSecureCookies).toBe(true);
    for (const config of [local, tunnel]) {
      expect(config.callbacks).toBe(authConfig.callbacks);
      expect(config.providers).toBe(authConfig.providers);
      expect(config.session).toBe(authConfig.session);
      expect(config.session?.maxAge).toBe(8 * 60 * 60);
    }
    expect(authConfig).not.toHaveProperty("cookies");
  });

  it("preserves D62 channel and department scope in the request-aware sign-in callback", async () => {
    const jwt = authConfigForRequest().callbacks?.jwt;
    if (!jwt) throw new Error("The current JWT callback must exist");
    const token = await jwt({
      token: {},
      user: {
        id: "17", name: "Scoped operator", roles: ["ops"], isApprover: false,
        sessionVersion: 4, scopeVersion: 4, channelScope: [2], deptScope: ["EC"],
      },
      account: null,
      trigger: "signIn",
    });
    expect(token).toMatchObject({
      userId: 17, roles: ["ops"], sessionVersion: 4, scopeVersion: 4,
      channelScope: [2], deptScope: ["EC"],
    });
  });

  it("rejects an older-than-eight-hours legacy token before the auth session endpoint can renew it", async () => {
    const jwt = authConfigForRequest().callbacks?.jwt;
    if (!jwt) throw new Error("The current JWT callback must exist");
    const now = Math.floor(Date.now() / 1000);
    const result = await jwt({
      token: { userId: 17, sessionVersion: 4, iat: now - 8 * 60 * 60, exp: now + 30 * 24 * 60 * 60 },
      account: null,
    } as Parameters<typeof jwt>[0]);
    expect(result).toBeNull();
  });

  it("keeps middleware read-only and statically exportable while the auth route is request-aware", () => {
    const middleware = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
    const entry = readFileSync(new URL("../src/server/auth/index.ts", import.meta.url), "utf8");
    expect(middleware).toContain("export default async function middleware");
    expect(middleware).toContain("export const config = {");
    expect(middleware).toContain("await getToken(");
    expect(middleware).not.toMatch(/NextAuth\s*\(/);
    expect(middleware).not.toContain("authConfigForRequest");
    expect(entry).toContain("NextAuth((request) => authConfigForRequest(request))");
  });
});
