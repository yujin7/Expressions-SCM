import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth } from "@auth/core";
import { decode, encode } from "@auth/core/jwt";
import type { CredentialsConfig } from "@auth/core/providers/credentials";
import { NextRequest } from "next/server";

// Only bridge the Next adapter's extensionless Node ESM imports. The error class,
// Credentials construction, Auth core, CSRF signing and JWT crypto remain real.
vi.mock("next-auth", async () => ({ CredentialsSignin: (await import("@auth/core/errors")).CredentialsSignin }));
vi.mock("next-auth/providers/credentials", async () => ({ default: (await import("@auth/core/providers/credentials")).default }));
const probes = vi.hoisted(() => ({ db: vi.fn(), refresh: vi.fn(), fetch: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock("@/db", async () => ({ schema: await import("@/db/schema"), getDbAsync: probes.db }));
vi.mock("@/server/auth/session-version", () => ({ refreshSessionIdentity: probes.refresh }));

const SECRET = "synthetic-signout-protocol-secret-not-used-by-any-deployment";
const SESSION_COOKIE = "authjs.session-token";
const CSRF_COOKIE = "authjs.csrf-token";
const CLAIMS = { userId: 17, sessionVersion: 4, name: "QA synthetic signout", roles: ["ops"], channelScope: [2], deptScope: ["EC"], scopeVersion: 4 };
let application: typeof import("@/server/auth/config");

beforeAll(async () => {
  // Capture current application configuration only after removing external identities.
  // No .env file or real account is read, and no network/database is available.
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_URL", "https://other-supported-origin.example");
  vi.stubEnv("FEISHU_APP_ID", undefined);
  vi.stubEnv("FEISHU_APP_SECRET", undefined);
  application = await import("@/server/auth/config");
});
beforeEach(() => {
  probes.db.mockReset().mockImplementation(() => { throw new Error("Synthetic DB unavailable"); });
  probes.refresh.mockReset().mockImplementation(() => { throw new Error("Synthetic identity refresh unavailable"); });
  probes.fetch.mockReset().mockImplementation(() => { throw new Error("External network forbidden in signout protocol tests"); });
  probes.error.mockReset(); probes.warn.mockReset(); probes.debug.mockReset();
  vi.stubGlobal("fetch", probes.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => { vi.unstubAllEnvs(); });

type Jar = Map<string, string>;
const responseRequestOrigins = new WeakMap<Response, string>();
function isSessionCookie(name: string) { return name === SESSION_COOKIE || name.startsWith(`${SESSION_COOKIE}.`); }
function sessionEntries(jar: Jar) { return [...jar].filter(([name]) => isSessionCookie(name)); }
function cookieName(header: string) { return header.slice(0, header.indexOf("=")); }
function receiveCookies(jar: Jar, response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    if (/;\s*Max-Age=0(?:;|$)/i.test(header)) jar.delete(name);
    else jar.set(name, pair.slice(separator + 1));
  }
}
function noDatabaseOrExternalWork() {
  expect(probes.refresh).not.toHaveBeenCalled();
  expect(probes.db).not.toHaveBeenCalled();
  expect(probes.fetch).not.toHaveBeenCalled();
}

async function core(origin: string, action: "csrf" | "signout" | "session", jar: Jar, body?: URLSearchParams) {
  const headers = new Headers({ cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") });
  if (body) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    headers.set("X-Auth-Return-Redirect", "1");
  }
  const request = new NextRequest(`${origin}/api/auth/${action}`, { method: body ? "POST" : "GET", headers, body });
  const current = application.authConfigForRequest(request);
  // Keep actual providers, JWT/session callbacks, lifetime and cookie policy.
  // basePath is the existing NextAuth adapter default, not a new auth endpoint.
  const config = { ...current, basePath: "/api/auth", logger: { error: probes.error, warn: probes.warn, debug: probes.debug } };
  expect(config.callbacks).toBe(application.authConfig.callbacks);
  expect(config.providers).toBe(application.authConfig.providers);
  expect(config.session).toBe(application.authConfig.session);
  expect(config.session?.strategy).toBe("jwt");
  expect(config.secret).toBe(SECRET);
  expect(config.adapter).toBeUndefined();
  expect(config.events?.signOut).toBeUndefined();
  expect(config.cookies?.sessionToken?.name).toBe(SESSION_COOKIE);
  expect(config.cookies?.csrfToken?.name).toBe(CSRF_COOKIE);
  const response = await Auth(request, config);
  responseRequestOrigins.set(response, new URL(request.url).origin);
  return response;
}

async function bootstrapCsrf(origin: string, jar: Jar) {
  const response = await core(origin, "csrf", jar);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const csrf: unknown = await response.json();
  expect(csrf).toEqual({ csrfToken: expect.stringMatching(/^[a-f0-9]{64}$/) });
  receiveCookies(jar, response);
  expect(jar.has(CSRF_COOKIE)).toBe(true);
  return (csrf as { csrfToken: string }).csrfToken;
}

type SessionKind = "valid" | "expired" | "damaged" | "chunked" | "stale-identity" | "none";
async function fixture(kind: SessionKind): Promise<Jar> {
  const jar: Jar = new Map([["qa-unrelated-cookie", "preserve-this-value"]]);
  if (kind === "none") return jar;
  let token = await encode({
    secret: SECRET, salt: SESSION_COOKIE, maxAge: kind === "expired" ? -60 : 8 * 60 * 60,
    token: {
      ...CLAIMS,
      ...(kind === "stale-identity" ? { sessionVersion: 999 } : {}),
      ...(kind === "chunked" ? { channelScope: Array.from({ length: 1800 }, (_, i) => i + 1) } : {}),
    },
  });
  if (kind === "damaged") token = `${token.slice(0, -16)}not-valid-crypto`;
  if (kind === "chunked") {
    expect(token.length).toBeGreaterThan(4096);
    const chunks = token.match(/.{1,1500}/g)!;
    // Real SessionStore must reassemble numeric chunk order, not request order.
    for (let i = chunks.length - 1; i >= 0; i -= 1) jar.set(`${SESSION_COOKIE}.${i}`, chunks[i]);
  } else jar.set(SESSION_COOKIE, token);
  return jar;
}

describe.each(["http://127.0.0.1:3100", "https://scm.example.test"])("real Auth.js signout without a database: %s", (origin) => {
  it.each<SessionKind>(["valid", "expired", "damaged", "chunked", "stale-identity", "none"])("safely signs out %s cookies using current app policy", async (kind) => {
    const jar = await fixture(kind);
    const originalNames = sessionEntries(jar).map(([name]) => name).sort();
    const csrfToken = await bootstrapCsrf(origin, jar);
    noDatabaseOrExternalWork();
    const response = await core(origin, "signout", jar, new URLSearchParams({ csrfToken, callbackUrl: "/login" }));
    expect(response.status).toBe(200);
    // Installed NextRequest normalizes loopback IPs to localhost unless its URL
    // normalization flag is disabled. Require the exact origin actually passed
    // to Auth core, not an arbitrary redirect origin or the pre-normalized input.
    // SignOutForm deliberately navigates relative /login regardless of this URL;
    // its existing component tests separately assert that same-browser behavior.
    const requestOrigin = responseRequestOrigins.get(response);
    expect(requestOrigin).toBeDefined();
    expect(await response.json()).toEqual({ url: new URL("/login", requestOrigin).href });
    const cleared = response.headers.getSetCookie().filter((header) => isSessionCookie(cookieName(header)));
    expect(cleared.map(cookieName).sort()).toEqual(originalNames);
    for (const cookie of cleared) {
      expect(cookie).toMatch(/;\s*Max-Age=0(?:;|$)/i);
      expect(cookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
      expect(cookie).toMatch(/;\s*SameSite=Lax(?:;|$)/i);
      expect(/;\s*Secure(?:;|$)/i.test(cookie)).toBe(origin.startsWith("https:"));
      expect(cookie).not.toMatch(/;\s*Domain=/i);
    }
    receiveCookies(jar, response);
    expect(sessionEntries(jar)).toEqual([]);
    expect(jar.get("qa-unrelated-cookie")).toBe("preserve-this-value");
    const anonymous = await core(origin, "session", jar);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toBeNull();
    noDatabaseOrExternalWork();
  });

  it("GET signout only renders confirmation and does not clear or refresh the authenticated session", async () => {
    const jar = await fixture("valid");
    const original = sessionEntries(jar);
    const response = await core(origin, "signout", jar);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.getSetCookie().filter((header) => isSessionCookie(cookieName(header)))).toEqual([]);
    receiveCookies(jar, response);
    expect(sessionEntries(jar)).toEqual(original);
    noDatabaseOrExternalWork();
  });

  it.each(["missing-token", "wrong-token", "missing-cookie", "forged-cookie", "other-browser-token"] as const)("rejects %s without clearing or reissuing the session", async (kind) => {
    const jar = await fixture("valid");
    const original = sessionEntries(jar);
    let csrfToken = await bootstrapCsrf(origin, jar);
    if (kind === "missing-token") csrfToken = "";
    if (kind === "wrong-token") csrfToken = `${csrfToken[0] === "a" ? "b" : "a"}${csrfToken.slice(1)}`;
    if (kind === "missing-cookie") jar.delete(CSRF_COOKIE);
    if (kind === "forged-cookie") jar.set(CSRF_COOKIE, encodeURIComponent(`${csrfToken}|${"0".repeat(64)}`));
    if (kind === "other-browser-token") {
      const other = await bootstrapCsrf(origin, new Map());
      expect(other).not.toBe(csrfToken);
      csrfToken = other;
    }
    const body = new URLSearchParams({ callbackUrl: "/login" });
    if (kind !== "missing-token") body.set("csrfToken", csrfToken);
    const response = await core(origin, "signout", jar, body);
    // Auth.js can represent CSRF failure as HTTP 200 + an error redirect.
    const result: { url: string } = await response.json();
    expect(new URL(result.url).searchParams.has("error")).toBe(true);
    expect(response.headers.getSetCookie().filter((header) => isSessionCookie(cookieName(header)))).toEqual([]);
    receiveCookies(jar, response);
    expect(sessionEntries(jar)).toEqual(original);
    expect(await decode({ token: jar.get(SESSION_COOKIE), secret: SECRET, salt: SESSION_COOKIE })).toMatchObject(CLAIMS);
    noDatabaseOrExternalWork();
  });
});

describe("database dependency probes are active", () => {
  it("a valid session read still invokes the actual application's identity refresh callback", async () => {
    const jar = await fixture("valid");
    await core("http://127.0.0.1:3100", "session", jar);
    // Positive control: the preceding signout tests did not obtain green results
    // by replacing current callbacks with an empty/minimal auth configuration.
    expect(probes.refresh).toHaveBeenCalledTimes(1);
    expect(probes.refresh).toHaveBeenCalledWith(expect.objectContaining(CLAIMS));
    expect(probes.error).toHaveBeenCalled();
    expect(probes.fetch).not.toHaveBeenCalled();
  });

  it("the current Credentials authorize callback still reaches the failing database probe", async () => {
    const provider = application.authConfig.providers.find((entry) => typeof entry !== "function" && entry.type === "credentials");
    if (!provider || typeof provider === "function" || provider.type !== "credentials") throw new Error("Current credentials provider is missing");
    const candidate = provider.options?.authorize ?? provider.authorize;
    if (typeof candidate !== "function") throw new Error("Current credentials authorize callback is missing");
    const authorize = candidate as CredentialsConfig["authorize"];
    await expect(authorize({ username: "qa-signout-probe", password: "synthetic-unused-value" }, new Request("http://127.0.0.1:3100/api/auth/callback/local")))
      .rejects.toThrow("Synthetic DB unavailable");
    expect(probes.db).toHaveBeenCalledTimes(1);
    expect(probes.fetch).not.toHaveBeenCalled();
  });
});
