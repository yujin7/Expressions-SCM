/**
 * 限速键的可信来源（2026-08-07 上公网前审计发现的真实缺陷）。
 *
 * 事故机制：`clientIpOf` 原取 `x-forwarded-for` 的**首跳**。XFF 左侧各跳全部由客户端
 * 自带，攻击者每次换一个伪造值，每 IP 限速就完全失效——实测固定 XFF 时第 21 次起被限，
 * 而轮换 XFF 时 40/40 全部穿透到口令校验。
 *
 * 它单独看就会绕过每来源限速。旧版还会把失败写成数据库全局账号锁，二者叠加曾允许
 * 远程拒绝服务；全局自动锁现已移除，本测试继续钉住可信来源键，防止暴力破解防线回退。
 *
 * 这里钉住取值顺序：cf-connecting-ip > XFF 最右跳 > null。
 * 关键断言是**最左跳绝不可被采信**——那正是回退到旧实现时唯一会变红的地方。
 */
import { describe, expect, it, vi } from "vitest";

// 与 login-rate-limit 同样的处理：next-auth ESM 在 vitest 下解析 "next/server" 失败，
// 而这里要测的是零依赖纯函数，打桩掉即可。
vi.mock("next-auth", () => ({
  CredentialsSignin: class extends Error {
    code = "";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));

import { clientIpOf } from "@/server/auth/config";

/** 造一个只带指定头的请求（不依赖 next/server） */
function req(headers: Record<string, string>): Request {
  return { headers: new Headers(headers) } as Request;
}

describe("限速键：只采信不可伪造的来源", () => {
  it("穿隧道时以 cf-connecting-ip 为准——它由 Cloudflare 覆盖写入，客户端伪造不了", () => {
    const ip = clientIpOf(req({
      "cf-connecting-ip": "203.0.113.7",
      // 攻击者自带的伪造头必须被忽略
      "x-forwarded-for": "1.1.1.1, 2.2.2.2",
    }));
    expect(ip).toBe("203.0.113.7");
  });

  it("没有 cf 头时取 XFF 最右跳——左侧可伪造，右侧由最近一级代理追加", () => {
    // 攻击者伪造了左边两跳，真实 IP 由代理追加在最右
    expect(clientIpOf(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 198.51.100.9" })))
      .toBe("198.51.100.9");
  });

  it("绝不采信 XFF 最左跳——这正是旧实现的洞，回退到旧实现此条必红", () => {
    const forged = "6.6.6.6";
    const real = "198.51.100.9";
    const ip = clientIpOf(req({ "x-forwarded-for": `${forged}, ${real}` }));
    expect(ip).not.toBe(forged);
    expect(ip).toBe(real);
  });

  it("轮换伪造前缀不能制造出不同的限速键——键必须稳定，否则限速等于没有", () => {
    const keys = new Set(
      ["a", "b", "c", "d", "e"].map((_, i) =>
        clientIpOf(req({ "x-forwarded-for": `10.0.0.${i}, 198.51.100.9` })),
      ),
    );
    // 五次伪造前缀各不相同，但真实来源同一个 → 必须收敛成一个键
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("198.51.100.9");
  });

  it("单跳 XFF 仍然正确（最右即最左）", () => {
    expect(clientIpOf(req({ "x-forwarded-for": "198.51.100.9" }))).toBe("198.51.100.9");
  });

  it("取不到则返回 null——直连时跳过每 IP 限速，与改动前行为一致", () => {
    expect(clientIpOf(req({}))).toBeNull();
    expect(clientIpOf(undefined)).toBeNull();
    // 空值/纯逗号不得产生空字符串键（空键会把所有匿名请求并成一个桶）
    expect(clientIpOf(req({ "x-forwarded-for": "  ,  " }))).toBeNull();
    expect(clientIpOf(req({ "cf-connecting-ip": "   " }))).toBeNull();
  });
});
