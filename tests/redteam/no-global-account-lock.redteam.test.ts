/** 公网登录不得因匿名失败写入全局账号锁。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const auth = readFileSync("src/server/auth/config.ts", "utf8");

describe("登录拒绝服务护栏", () => {
  it("错误口令仅进入用户名+来源内存桶，不写 users.failed_logins/locked_until", () => {
    expect(auth).toContain("principalSourceBlocked(username, source)");
    expect(auth).toContain("recordFailure(username, source)");
    expect(auth).not.toMatch(/if\s*\(failed\s*>=/);
    expect(auth).not.toMatch(/lockedUntil:\s*new Date/);
    expect(auth).not.toContain('throw new LoginError("locked")');
  });

  it("直连请求也进入稳定来源桶，不得完全跳过 IP 限速", () => {
    expect(auth).toContain('const source = ip ?? "direct"');
    expect(auth).toContain("touchIp(source)");
  });
});
