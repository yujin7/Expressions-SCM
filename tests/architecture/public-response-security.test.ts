/** 公网入口的浏览器与 token 响应安全基线。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("公网响应安全", () => {
  it("全站有 CSP，登录和 Auth.js 响应明确禁止缓存", () => {
    const config = readFileSync("next.config.ts", "utf8");
    const login = readFileSync("src/app/login/page.tsx", "utf8");
    expect(config).toContain("Content-Security-Policy");
    expect(config).toContain("frame-ancestors 'none'");
    expect(config).toContain('source: "/login"');
    expect(config).toContain('source: "/api/auth/:path*"');
    expect(config.match(/private, no-store, max-age=0/g)?.length).toBeGreaterThanOrEqual(2);
    expect(login).toContain('dynamic = "force-dynamic"');
  });

  it("两个公开 token 路由的成功与错误响应共用 no-store 包装", () => {
    for (const path of [
      "src/app/api/public/e-label/[token]/route.ts",
      "src/app/api/public/po-confirm/[token]/route.ts",
    ]) {
      const route = readFileSync(path, "utf8");
      expect(route).toContain("protectTokenResponse");
      expect(route).toContain("private, no-store, max-age=0");
      expect(route).not.toMatch(/catch \(e\) \{\s*return errorResponse\(/);
    }
  });
});
