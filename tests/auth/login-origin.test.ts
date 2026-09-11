import { describe, expect, it } from "vitest";
import { loginOriginForRequest } from "@/server/auth/login-origin";

const PUBLIC = "https://configured-origin.example";
function resolve(host: string | null, configured: string | undefined = PUBLIC, url = "http://0.0.0.0:3000/todo") {
  // A minimal header interface also lets us exercise invalid control characters
  // which the native Headers constructor rejects before middleware is reached.
  return loginOriginForRequest({ url, headers: { get: (name) => name === "host" ? host : "https://untrusted.example" } }, configured);
}

describe("bounded same-entry login origin policy", () => {
  it.each([
    ["localhost", "http://localhost"], ["LOCALHOST:3100", "http://localhost:3100"],
    ["127.0.0.1:3100", "http://127.0.0.1:3100"], ["[::1]:3100", "http://[::1]:3100"],
    ["127.0.0.1:1", "http://127.0.0.1:1"], ["[::1]:65535", "http://[::1]:65535"],
    ["127.0.0.1:80", "http://127.0.0.1"],
  ])("preserves exact loopback authority %s as %s", (host, expected) => {
    expect(resolve(host)).toBe(expected);
  });

  it.each([
    ["configured-origin.example", PUBLIC, PUBLIC],
    ["CONFIGURED-ORIGIN.EXAMPLE:443", PUBLIC, PUBLIC],
    ["192.168.1.10:3100", "http://192.168.1.10:3100", "http://192.168.1.10:3100"],
    ["scm.local:3100", "http://scm.local:3100/api/auth", "http://scm.local:3100"],
    ["[fd00::10]:3100", "http://[fd00::10]:3100", "http://[fd00::10]:3100"],
    ["localhost:3443", "https://localhost:3443", "https://localhost:3443"],
    ["127.0.0.1", "https://127.0.0.1", "https://127.0.0.1"],
  ])("honors the explicitly configured origin before loopback defaults for %s", (host, configured, expected) => {
    expect(resolve(host, configured)).toBe(expected);
  });

  it.each([
    "", " ", "localhost:0", "localhost:65536", "localhost:03100", "localhost:", "localhost:-1", "localhost:+3100",
    "localhost:3e3", "localhost:3100.0", "localhost:80:90", "localhost,configured-origin.example", "localhost\n",
    "localhost\r\nx-evil:yes", "localhost\u0000", "localhost/evil", "localhost\\evil", "localhost?evil", "localhost#evil",
    "http://localhost:3100", "localhost:3100@untrusted.example", "user@localhost:3100", "localhost%2euntrusted.example",
    "localhost.untrusted.example", "localhost.", "127.0.0.2:3100", "127.1:3100", "2130706433:3100", "0x7f000001:3100",
    "0177.0.0.1:3100", "[0:0:0:0:0:0:0:1]:3100", "[::ffff:127.0.0.1]:3100", "::1:3100", "[::1%25lo0]:3100",
    "configured-origin.example.untrusted.example", "other.trycloudflare.com", "configured-origin.example:444",
    "192.168.1.10:3100", "scm.local:3100", "bad..name", "-bad.example", "bad-.example", `${"a".repeat(64)}.example`,
  ])("rejects unsupported/malformed authority %j without falling back to the URL", (host) => {
    expect(resolve(host, PUBLIC, "http://127.0.0.1:3100/todo")).toBeNull();
  });

  it.each([undefined, "", "not-a-url", "//configured-origin.example", "ftp://configured-origin.example", "https://user:password@configured-origin.example", "https://configured-origin.example:0", "https://configured-origin.example:65536", "https://configured-origin.example\\untrusted.example", "https://configured-origin.example\n"])("invalid configuration %j never trusts a public Host", (configured) => {
    expect(loginOriginForRequest({ url: "http://localhost:3000/todo", headers: { get: () => "configured-origin.example" } }, configured)).toBeNull();
    expect(loginOriginForRequest({ url: "http://localhost:3000/todo", headers: { get: () => "127.0.0.1:3100" } }, configured)).toBe("http://127.0.0.1:3100");
  });

  it.each([
    ["http://127.0.0.1:3100/todo", "http://127.0.0.1:3100"],
    ["http://[::1]:3100/todo", "http://[::1]:3100"],
    ["http://configured-origin.example/todo", PUBLIC],
    ["http://0.0.0.0:3000/todo", null], ["https://untrusted.example/todo", null],
    ["//localhost:3100/todo", null], ["http://user@localhost:3100/todo", null],
    ["http://127.1:3100/todo", null], ["http://localhost:03100/todo", null],
  ])("uses only the same bounded URL fallback when Host is absent: %s", (url, expected) => {
    expect(resolve(null, PUBLIC, url)).toBe(expected);
  });

  it("never consults any forwarded header", () => {
    const calls: string[] = [];
    expect(loginOriginForRequest({ url: "http://0.0.0.0:3000/todo", headers: { get: (name) => {
      calls.push(name); return name === "host" ? "127.0.0.1:3100" : "untrusted.example";
    } } }, PUBLIC)).toBe("http://127.0.0.1:3100");
    expect(calls).toEqual(["host"]);
  });
});
