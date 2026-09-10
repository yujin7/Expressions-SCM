import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tsx = createRequire(import.meta.url).resolve("tsx");
const revision = "a".repeat(40);
function probe(protocol: "http" | "https", cookie: string | null, sessionCookie?: string) {
  const preload = `globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/health')) return Response.json({ok:true,dbOk:true,drift:false,migrationState:'current',migrationFiles:64,applied:64,build:{revision:'${revision}',source:'build-arg'}});
    if (options?.method === 'POST') {
      console.log('CREDENTIAL_POST');
      const cookie = ${JSON.stringify(sessionCookie) ?? "undefined"};
      return cookie === undefined ? new Response('',{status:401})
        : new Response('',{status:302,headers:{location:'${protocol}://scm.invalid/workbench','set-cookie':cookie}});
    }
    const response = Response.json({csrfToken:'synthetic-csrf'});
    const cookie = ${JSON.stringify(cookie)};
    if (cookie !== null) response.headers.append('set-cookie',cookie);
    return response;
  };`;
  return spawnSync(process.execPath, ["--import", tsx, "--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.resolve("scripts/smoke-e2e.ts")], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, SMOKE_BASE: `${protocol}://scm.invalid`, SMOKE_PASSWORD: "synthetic-unused-password", SCM_EXPECTED_REVISION: revision },
  });
}

describe("smoke rejects browser-incompatible auth cookies before using passwords", () => {
  it.each([
    ["http", "__Host-authjs.csrf-token=synthetic; Path=/; HttpOnly; Secure; SameSite=Lax"],
    ["http", "authjs.csrf-token=synthetic; Path=/; secure"],
    ["https", "authjs.csrf-token=synthetic; Path=/; HttpOnly; SameSite=Lax"],
    ["http", null],
    ["https", null],
  ] as const)("refuses %s with %s without a credential POST", (protocol, cookie) => {
    const result = probe(protocol, cookie);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[FAIL] 登录 Cookie 与访问协议");
    expect(result.stdout).not.toContain("CREDENTIAL_POST");
  });
  it.each([
    ["http", "authjs.csrf-token=synthetic; Path=/; HttpOnly; SameSite=Lax"],
    ["https", "authjs.csrf-token=synthetic; Path=/; HttpOnly; Secure; SameSite=Lax"],
  ] as const)("admits matching %s policy but does not claim authenticated success", (protocol, cookie) => {
    const result = probe(protocol, cookie);
    expect(result.stdout).toContain("[PASS] 登录 Cookie 与访问协议");
    expect(result.stdout).toContain("CREDENTIAL_POST");
    expect(result.status).toBe(1);
  });

  it.each([
    ["http", "authjs.csrf-token=synthetic; Path=/; HttpOnly; SameSite=Lax", "authjs.session-token=synthetic; Path=/; Secure; HttpOnly"],
    ["https", "authjs.csrf-token=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax", "authjs.session-token=synthetic; Path=/; HttpOnly"],
  ] as const)("also rejects a mismatched session cookie after %s preflight succeeds", (protocol, csrfCookie, sessionCookie) => {
    const result = probe(protocol, csrfCookie, sessionCookie);
    expect(result.stdout).toContain("[PASS] 登录 Cookie 与访问协议");
    expect(result.stdout).toContain("CREDENTIAL_POST");
    expect(result.stdout).toContain("[FAIL] 登录 admin");
    expect(result.stdout).not.toContain("[PASS] 登录 admin");
    expect(result.status).toBe(1);
  });
});
