import { describe, expect, it } from "vitest";
import { loginReturnPath } from "@/lib/login-return-path";

describe("login return paths", () => {
  it.each([null, "", "https://evil.example", "//evil.example/path", "/\\evil.example/path", "/\n/evil.example/path", "javascript:alert(1)"])("rejects external or ambiguous destination %j", (value) => {
    expect(loginReturnPath(value)).toBe("/");
  });
  it.each(["/", "/todo?mine_status=active", "/review/checklist?id=15", "/inventory/balance?q=SKU%20001#details"])("preserves internal destination %s", (value) => {
    expect(loginReturnPath(value)).toBe(value);
  });
  it("normalizes paths before navigation and never creates a protocol-relative target", () => {
    expect(loginReturnPath("/report/../todo?id=7")).toBe("/todo?id=7");
    const target = loginReturnPath("/\\evil.example");
    expect(new URL(target, "https://scm.example").origin).toBe("https://scm.example");
  });
});
