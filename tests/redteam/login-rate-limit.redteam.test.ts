/**
 * 登录限速（红队第五轮）：内存滑动窗口纯逻辑直测（不触库、不走 next-auth 流程）。
 * 口径：每 IP 全部尝试 20 次 / 5 分钟；每用户名失败尝试 10 次 / 5 分钟（成功清零）；
 * 窗口滑动后自动放行；陈旧键可被清扫，Map 不无界增长。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// next-auth ESM 在 vitest 下解析 "next/server" 失败（无扩展名裸导入）——限速器
// 本身零依赖，这里把 next-auth 打桩掉，只取 config.ts 的纯逻辑导出。
vi.mock("next-auth", () => ({
  CredentialsSignin: class extends Error {
    code = "";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));

import { loginRateLimiter } from "@/server/auth/config";

const T0 = 1_800_000_000_000; // 固定基准时刻，避免真实时钟抖动
const MIN = 60_000;

describe("loginRateLimiter", () => {
  beforeEach(() => loginRateLimiter.reset());

  it("每 IP 20 次 / 5 分钟：第 21 次拒绝；窗口滑过后放行", () => {
    for (let i = 0; i < 20; i++) {
      expect(loginRateLimiter.touchIp("1.2.3.4", T0 + i * 1000)).toBe(true);
    }
    expect(loginRateLimiter.touchIp("1.2.3.4", T0 + 21_000)).toBe(false);
    // 其他 IP 不受影响
    expect(loginRateLimiter.touchIp("5.6.7.8", T0 + 21_000)).toBe(true);
    // 5 分钟窗口滑过：最早的尝试出窗，重新放行
    expect(loginRateLimiter.touchIp("1.2.3.4", T0 + 5 * MIN + 1000)).toBe(true);
  });

  it("被拒的尝试不计入窗口（拒绝不延长封禁）", () => {
    for (let i = 0; i < 20; i++) loginRateLimiter.touchIp("9.9.9.9", T0 + i);
    // 连续被拒 100 次——窗口内时间戳仍只有最初 20 个
    for (let i = 0; i < 100; i++) {
      expect(loginRateLimiter.touchIp("9.9.9.9", T0 + 10_000 + i)).toBe(false);
    }
    expect(loginRateLimiter.ipAttempts.get("9.9.9.9")!.length).toBe(20);
    // 最初 20 个出窗即恢复
    expect(loginRateLimiter.touchIp("9.9.9.9", T0 + 5 * MIN + 20)).toBe(true);
  });

  it("每用户名失败 10 次 / 5 分钟：第 11 次前 userBlocked；成功登录清零", () => {
    for (let i = 0; i < 9; i++) loginRateLimiter.recordFailure("alice", T0 + i * 1000);
    expect(loginRateLimiter.userBlocked("alice", T0 + 10_000)).toBe(false);
    loginRateLimiter.recordFailure("alice", T0 + 10_000);
    expect(loginRateLimiter.userBlocked("alice", T0 + 11_000)).toBe(true);
    // 其他用户名不受影响
    expect(loginRateLimiter.userBlocked("bob", T0 + 11_000)).toBe(false);
    // 成功登录清零
    loginRateLimiter.clearUser("alice");
    expect(loginRateLimiter.userBlocked("alice", T0 + 12_000)).toBe(false);
    // 窗口滑动自然解封
    for (let i = 0; i < 10; i++) loginRateLimiter.recordFailure("carol", T0 + i);
    expect(loginRateLimiter.userBlocked("carol", T0 + 10_000)).toBe(true);
    expect(loginRateLimiter.userBlocked("carol", T0 + 5 * MIN + 1)).toBe(false);
  });

  it("陈旧键清理：出窗检查即删除条目，Map 不残留", () => {
    loginRateLimiter.recordFailure("dave", T0);
    expect(loginRateLimiter.failedByUser.has("dave")).toBe(true);
    loginRateLimiter.userBlocked("dave", T0 + 6 * MIN); // 出窗检查触发删除
    expect(loginRateLimiter.failedByUser.has("dave")).toBe(false);
  });
});
