import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode, getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { NextURL } from "next/dist/server/web/next-url";
import middleware, { config } from "../src/middleware";
import { authCookieConfig } from "../src/server/auth/cookies";

// Synthetic fixture only; no production configuration or real account is read.
const SECRET = "middleware-test-secret-not-used-by-any-deployment";
const COOKIE = "authjs.session-token";
const CLAIMS = {
  userId: 17,
  sessionVersion: 4,
  roles: ["ops"],
  channelScope: [2],
  deptScope: ["EC"],
  scopeVersion: 4,
};

function request(path: string, cookie?: string, headers?: Record<string, string>) {
  const url = path.startsWith("http") ? path : `http://127.0.0.1:3100${path}`;
  return new NextRequest(url, {
    headers: { host: new URL(url).host, ...headers, ...(cookie === undefined ? {} : { cookie }) },
  });
}

function issue(overrides: Partial<Parameters<typeof encode>[0]> = {}) {
  return encode({ secret: SECRET, salt: COOKIE, token: CLAIMS, maxAge: 8 * 60 * 60, ...overrides });
}

function expectReadOnly(response: Response) {
  expect(response.headers.get("set-cookie")).toBeNull();
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_URL", "https://configured-origin.example");
  // Mirrors the public next.config option; the real installed adapter regression
  // separately proves the build-time flag is needed to preserve Location.
  vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "true");
});

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("read-only auth middleware with real Auth.js encryption", () => {
  it("uses the issuer's cookie name and salt without renewing expiry or rewriting scopes", async () => {
    expect(authCookieConfig().cookies?.sessionToken?.name).toBe(COOKIE);
    const encrypted = await issue();
    const req = request("/todo", `${COOKIE}=${encrypted}`);
    const before = await getToken({ req, secret: SECRET, cookieName: COOKIE, salt: COOKIE });
    expect(before).toMatchObject(CLAIMS);
    expect(before!.exp! - before!.iat!).toBe(8 * 60 * 60);

    for (let i = 0; i < 2; i++) {
      const response = await middleware(req);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expectReadOnly(response);
    }
    const after = await getToken({ req, secret: SECRET, cookieName: COOKIE, salt: COOKIE });
    expect(after).toEqual(before);
  });

  it.each([
    ["http://127.0.0.1:3100/todo", "http"],
    ["https://public-origin.example/todo", "https"],
    ["http://localhost:3000/todo", "https"],
  ])("reads the same cookie at %s without issuing Secure or non-Secure cookies", async (url, protocol) => {
    const encrypted = await issue();
    const response = await middleware(request(url, `${COOKIE}=${encrypted}`, {
      "x-forwarded-proto": protocol,
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expectReadOnly(response);
  });

  it("reassembles large D62 scope tokens in numeric chunk order", async () => {
    const encrypted = await issue({ token: { ...CLAIMS, channelScope: Array.from({ length: 2000 }, (_, i) => i + 1) } });
    expect(encrypted.length).toBeGreaterThan(4000);
    const chunks = encrypted.match(/.{1,1500}/g)!;
    const cookies = chunks.map((chunk, index) => `${COOKIE}.${index}=${chunk}`).reverse().join("; ");
    const response = await middleware(request("/api/todo", cookies));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expectReadOnly(response);

    const incomplete = chunks.slice(1).map((chunk, index) => `${COOKIE}.${index + 1}=${chunk}`).join("; ");
    const denied = await middleware(request("/api/todo", incomplete));
    expect(denied.status).toBe(401);
    expectReadOnly(denied);
  });

  it.each(["expired", "wrong-secret", "wrong-salt", "damaged"] as const)("rejects %s tokens without clearing or refreshing cookies", async (kind) => {
    const encrypted = kind === "expired" ? await issue({ maxAge: -60 })
      : kind === "wrong-secret" ? await issue({ secret: "another-synthetic-test-secret" })
        : kind === "wrong-salt" ? await issue({ salt: "__Secure-authjs.session-token" })
          : `${(await issue()).slice(0, -5)}wrong`;
    const response = await middleware(request("/api/todo", `${COOKIE}=${encrypted}`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
    expectReadOnly(response);
  });

  it("does not add Bearer authentication as an alternative to the existing cookie session", async () => {
    const response = await middleware(request("/api/todo", undefined, { authorization: `Bearer ${await issue()}` }));
    expect(response.status).toBe(401);
    expectReadOnly(response);
  });

  it("caps a legacy 30-day session at eight hours from issuance without rewriting its cookie", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const issuedAt = new Date("2026-09-06T00:00:00Z");
    vi.setSystemTime(issuedAt);
    const encrypted = await issue({ maxAge: 30 * 24 * 60 * 60 });
    const req = request("/api/todo", `${COOKIE}=${encrypted}`);
    vi.setSystemTime(issuedAt.getTime() + (8 * 60 * 60 - 1) * 1000);
    expect((await middleware(req)).headers.get("x-middleware-next")).toBe("1");
    vi.setSystemTime(issuedAt.getTime() + 8 * 60 * 60 * 1000);
    // Auth.js can still decrypt it, but the application lifetime no longer admits it.
    expect(await getToken({ req, secret: SECRET, cookieName: COOKIE, salt: COOKIE })).not.toBeNull();
    const expired = await middleware(req);
    expect(expired.status).toBe(401);
    expectReadOnly(expired);
  });

  it("does not accept old prefixed cookies as if their differently salted token were current", async () => {
    const encrypted = await issue({ salt: "__Secure-authjs.session-token" });
    const response = await middleware(request("/api/todo", `__Secure-authjs.session-token=${encrypted}`));
    expect(response.status).toBe(401);
    expectReadOnly(response);
  });

  it("fails closed when the deployment secret is missing", async () => {
    const encrypted = await issue();
    vi.stubEnv("AUTH_SECRET", undefined);
    const response = await middleware(request("/api/todo", `${COOKIE}=${encrypted}`));
    expect(response.status).toBe(401);
    expectReadOnly(response);
  });

  it.each(["http://127.0.0.1:3100", "http://localhost:3100", "http://[::1]:3100", "https://configured-origin.example"])("redirects anonymous pages at %s with a framework-compatible absolute Location", async (origin) => {
    const req = request(`${origin}/todo?source=alert&id=7`, undefined, {
      "x-forwarded-host": "untrusted.example",
      "x-forwarded-proto": "https",
    });
    const response = await middleware(req);
    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    // Match Next 15's adapter: it parses Location with NextURL and no base URL.
    // A browser-valid relative redirect would throw here and cause a runtime 500.
    expect(() => new NextURL(location, { headers: Object.fromEntries(req.headers), nextConfig: {} })).not.toThrow();
    // Compare with the browser's original WHATWG origin, never two NextURLs:
    // both would normalize 127.0.0.1 to localhost and hide the regression.
    const resolved = new URL(location);
    expect(resolved.origin).toBe(new URL(origin).origin);
    expect(resolved.pathname).toBe("/login");
    expect(resolved.searchParams.get("callbackUrl")).toBe("/todo?source=alert&id=7");
    expectReadOnly(response);
  });

  it("uses the exact configured public origin with an internal container URL and ignores hostile proxy headers", async () => {
    const response = await middleware(request("http://0.0.0.0:3000/todo?source=alert", undefined, {
      host: "configured-origin.example", "x-forwarded-host": "untrusted.example", "x-forwarded-proto": "http",
    }));
    expect(response.headers.get("location")).toBe("https://configured-origin.example/login?callbackUrl=%2Ftodo%3Fsource%3Dalert");
    expectReadOnly(response);
  });

  it("preserves the external loopback port instead of a container's binding port", async () => {
    const response = await middleware(request("http://0.0.0.0:3000/todo", undefined, { host: "127.0.0.1:3100" }));
    expect(new URL(response.headers.get("location")!).origin).toBe("http://127.0.0.1:3100");
  });

  it.each(["untrusted.example", "192.168.1.77:3100", "unconfigured.local:3100", "configured-origin.example:444", "localhost:3100@untrusted.example", ""])("gives unknown/invalid Host %s a safe current-entry login link without a redirect", async (host) => {
    const response = await middleware(request("/todo?sentinel=UNTRUSTED_QUERY_SENTINEL", undefined, { host, "x-forwarded-host": "configured-origin.example" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain('<a href="/login">在当前入口登录</a>');
    expect(html).toContain("此入口未配置自动登录跳转");
    expect(html).not.toContain("UNTRUSTED_QUERY_SENTINEL");
    if (host) expect(html).not.toContain(host);
    expectReadOnly(response);
  });

  it("keeps anonymous API errors machine-readable even with an unknown Host", async () => {
    const response = await middleware(request("/api/todo", undefined, { host: "untrusted.example" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not impose a new Host restriction on an already authenticated LAN request", async () => {
    const response = await middleware(request("/todo", `${COOKIE}=${await issue()}`, { host: "192.168.1.77:3100" }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expectReadOnly(response);
  });

  it.each(["/supplier/confirm", "/supplier/confirm/token", "/e-label", "/e-label/token", "/api/public", "/api/public/token"])("keeps public root/subpath %s available without a session", async (path) => {
    vi.stubEnv("AUTH_SECRET", undefined);
    const response = await middleware(request(path));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expectReadOnly(response);
  });

  it.each(["/supplier/confirm-admin", "/e-labels", "/api/public-admin"])("does not make sibling path %s public", async (path) => {
    const response = await middleware(request(path));
    expect(response.status).toBe(path.startsWith("/api/") ? 401 : 302);
    expectReadOnly(response);
  });

  it.each(["none", "expired", "damaged", "no-secret"] as const)("keeps exact sign-out confirmation reachable with %s session without issuing cookies", async (state) => {
    const cookie = state === "none" ? undefined : state === "damaged" ? `${COOKIE}=damaged`
      : `${COOKIE}=${await issue(state === "expired" ? { maxAge: -60 } : {})}`;
    if (state === "no-secret") vi.stubEnv("AUTH_SECRET", undefined);
    const response = await middleware(request("/signout?callbackUrl=https://untrusted.example", cookie));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
    expectReadOnly(response);
  });

  it.each(["/signout/child", "/signout-admin", "/api/signout", "/todo", "/api/todo"])("does not widen sign-out exemption to %s", async (path) => {
    const response = await middleware(request(path));
    expect(response.status).toBe(path.startsWith("/api/") ? 401 : 302);
    expectReadOnly(response);
  });

  it("keeps literal matcher exclusions precise for login, auth routes and public assets", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/login", "/api/auth/session", "/api/health", "/api/public/token", "/logo.png", "/icon.png", "/_next/static/app.js"]) {
      expect(matcher.test(path), path).toBe(false);
    }
    for (const path of ["/login-admin", "/api/auth-admin", "/api/health-admin", "/api/public-admin", "/logo.png/private", "/todo", "/signout", "/signout/child", "/signout-admin"]) {
      expect(matcher.test(path), path).toBe(true);
    }
  });
});
