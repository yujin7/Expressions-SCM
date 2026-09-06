import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../../next.config";
import middleware from "../../src/middleware";

type Fixture = {
  name: string; url: string; host: string; skip: boolean;
  requestHeaders?: Record<string, string>; location?: string; status: number;
};
type Outcome = { name: string; status?: number; location?: string | null; dataRedirect?: string | null; requestUrl?: string; error?: string };
let outcomes: Outcome[];

// Execute the installed, unmodified Next adapter in one fresh Node process.
// This supplies Next's actual AsyncLocalStorage bootstrap before its imports,
// independent of other Vitest files' cached next/server modules. There is no
// server, database, .env loading, business instrumentation, or network access.
// Application middleware creates each response below; the real adapter then
// processes that response, including its second Location normalization pass.
const ADAPTER_PROBE = String.raw`
  import { createRequire } from "node:module";
  import { readFileSync } from "node:fs";
  const require = createRequire(process.cwd() + "/synthetic-login-adapter-probe.cjs");
  require("next/dist/server/node-environment-baseline");
  globalThis.fetch = () => { throw new Error("Network forbidden in adapter probe"); };
  const { adapter } = require("next/dist/server/web/adapter");
  const cases = JSON.parse(readFileSync(0, "utf8"));
  const results = [];
  for (const fixture of cases) {
    if (fixture.skip) process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = "true";
    else delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
    let requestUrl;
    try {
      const result = await adapter({
        page: "/middleware",
        request: {
          url: fixture.url, method: "GET", signal: new AbortController().signal,
          headers: { host: fixture.host, ...fixture.requestHeaders }, nextConfig: {},
        },
        handler: async (request) => {
          requestUrl = request.url;
          return new Response(null, {
            status: fixture.status,
            headers: fixture.location === undefined ? {} : { Location: fixture.location },
          });
        },
      });
      await result.waitUntil;
      results.push({ name: fixture.name, status: result.response.status,
        location: result.response.headers.get("Location"),
        dataRedirect: result.response.headers.get("x-nextjs-redirect"), requestUrl });
    } catch (error) {
      results.push({ name: fixture.name, error: error instanceof Error ? error.message : "Unknown error" });
    }
  }
  process.stdout.write(JSON.stringify(results));
`;

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", undefined);
  vi.stubEnv("AUTH_URL", "https://configured-origin.example");
  vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "true");
  const inputs: Array<Omit<Fixture, "status" | "location">> = [
    { name: "default-127-negative", url: "http://127.0.0.1:3100/todo", host: "127.0.0.1:3100", skip: false },
    { name: "default-ipv6-negative", url: "http://[::1]:3100/todo", host: "[::1]:3100", skip: false },
    { name: "preserved-127", url: "http://127.0.0.1:3100/todo?source=alert&id=7", host: "127.0.0.1:3100", skip: true },
    { name: "preserved-localhost", url: "http://localhost:3100/todo", host: "localhost:3100", skip: true },
    { name: "preserved-ipv6", url: "http://[::1]:3290/todo", host: "[::1]:3290", skip: true },
    { name: "mapped-port", url: "http://0.0.0.0:3000/todo", host: "127.0.0.1:3100", skip: true },
    { name: "public-https", url: "http://0.0.0.0:3000/todo", host: "configured-origin.example", skip: true },
    { name: "unknown-host", url: "http://0.0.0.0:3000/todo", host: "untrusted.example", skip: true },
    { name: "rsc-navigation", url: "http://127.0.0.1:3100/todo", host: "127.0.0.1:3100", skip: true, requestHeaders: { rsc: "1" } },
    { name: "next-data-navigation", url: "http://127.0.0.1:3100/todo", host: "127.0.0.1:3100", skip: true, requestHeaders: { "x-nextjs-data": "1" } },
  ];
  const fixtures: Fixture[] = [];
  for (const input of inputs) {
    const response = await middleware(new NextRequest(input.url, {
      headers: { host: input.host, ...input.requestHeaders },
    }));
    fixtures.push({ ...input, status: response.status, location: response.headers.get("location") ?? undefined });
  }
  // Deliberately invalid response proves a plain relative Location cannot be
  // substituted for the allowlisted absolute origin, even with normalization off.
  fixtures.push({ name: "relative-location-negative", url: "http://127.0.0.1:3100/todo", host: "127.0.0.1:3100", skip: true, status: 302, location: "/login" });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", ADAPTER_PROBE], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { NODE_ENV: "test", NEXT_PHASE: "phase-production-build" },
    input: JSON.stringify(fixtures), encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  outcomes = JSON.parse(result.stdout) as Outcome[];
});
afterAll(() => { vi.unstubAllEnvs(); });

function outcome(name: string): Outcome {
  const result = outcomes.find((value) => value.name === name);
  expect(result, name).toBeDefined();
  return result!;
}

describe("installed Next 15 middleware adapter origin contract", () => {
  it("enables the supported build-time normalization opt-out in actual next.config", () => {
    expect(nextConfig.skipMiddlewareUrlNormalize).toBe(true);
  });

  it.each(["default-127-negative", "default-ipv6-negative"])("reproduces the default host-changing defect: %s", (name) => {
    const result = outcome(name);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(302);
    expect(new URL(result.location!).origin).toBe("http://localhost:3100");
  });

  it.each([
    ["preserved-127", "http://127.0.0.1:3100"], ["preserved-localhost", "http://localhost:3100"],
    ["preserved-ipv6", "http://[::1]:3290"], ["mapped-port", "http://127.0.0.1:3100"],
    ["public-https", "https://configured-origin.example"], ["rsc-navigation", "http://127.0.0.1:3100"],
  ])("preserves the complete allowed browser origin through the actual adapter: %s", (name, origin) => {
    const result = outcome(name);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(302);
    const target = new URL(result.location!);
    expect(target.origin).toBe(origin);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("callbackUrl")).toBe(name === "preserved-127" ? "/todo?source=alert&id=7" : "/todo");
  });

  it("retains raw loopback request.url when the public option's flag is enabled", () => {
    expect(outcome("preserved-127").requestUrl).toBe("http://127.0.0.1:3100/todo?source=alert&id=7");
    expect(outcome("preserved-ipv6").requestUrl).toBe("http://[::1]:3290/todo");
  });

  it("keeps the safe unknown-host result free of a redirect", () => {
    expect(outcome("unknown-host")).toMatchObject({ status: 400, location: null });
    expect(outcome("unknown-host").error).toBeUndefined();
  });

  it("keeps Next's data-navigation redirect relative to the same browser origin", () => {
    expect(outcome("next-data-navigation")).toMatchObject({ status: 302, location: null, dataRedirect: "/login?callbackUrl=%2Ftodo" });
    expect(outcome("next-data-navigation").error).toBeUndefined();
  });

  it("rejects a relative middleware Location even when normalization is disabled", () => {
    expect(outcome("relative-location-negative").error).toBeTruthy();
    expect(outcome("relative-location-negative").status).toBeUndefined();
  });
});
