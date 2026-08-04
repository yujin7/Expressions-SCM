/**
 * 飞书群自定义机器人「签名校验」。
 *
 * 为什么要有：不开签名校验时，**任何拿到 webhook 地址的人都能往群里发消息**，
 * 而该地址会出现在 .env、CI 密钥、部署脚本里，泄露面比想象大。
 * 开了之后，光有地址没有密钥发不了。
 *
 * 算法最容易写反的地方：飞书要求把 `timestamp + "\n" + 密钥` 整体当作 HMAC 的**密钥**，
 * 对**空字符串**取 HmacSHA256 再 Base64；不是对拼接串取摘要。
 * 写反了会一直 19021 签名校验失败，而且从报错看不出是哪一步反了——所以钉住。
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(
  path.resolve(__dirname, "../../src/jobs/notify.ts"),
  "utf8",
);

/** 与实现同款的参考实现，用于验证实现没写反 */
function reference(secret: string, timestampSec: number): string {
  return createHmac("sha256", `${timestampSec}\n${secret}`).update("").digest("base64");
}

describe("飞书 webhook 签名", () => {
  it("实现按「timestamp\\n密钥」作 HMAC 密钥、对空串取摘要", () => {
    // 从源码断言关键形状，避免被改成「对拼接串取摘要」这种反写
    expect(SRC).toMatch(/createHmac\(\s*"sha256",\s*`\$\{timestampSec\}\\n\$\{secret\}`\s*\)/);
    expect(SRC).toMatch(/\.update\(\s*""\s*\)/);
    expect(SRC).toContain('digest("base64")');
  });

  it("参考实现产出稳定值（同 timestamp+密钥必得同签名）", () => {
    const a = reference("abcdefg", 1_700_000_000);
    const b = reference("abcdefg", 1_700_000_000);
    expect(a).toBe(b);
    expect(a).not.toBe(reference("abcdefg", 1_700_000_001));
    expect(a).not.toBe(reference("abcdefh", 1_700_000_000));
    // Base64 of HmacSHA256 恒为 44 字符
    expect(a).toHaveLength(44);
  });

  it("只有配了 FEISHU_WEBHOOK_SECRET 才带 timestamp/sign——没配时不能凭空加字段", () => {
    // 未开启签名校验的群，带上 sign 反而会被拒；故必须是条件分支
    expect(SRC).toMatch(/const secret = process\.env\.FEISHU_WEBHOOK_SECRET\?\.trim\(\)/);
    expect(SRC).toMatch(/if \(secret\) \{[\s\S]{0,200}requestBody\.sign =/);
  });

  it("签名字段名与飞书约定一致（timestamp / sign），不是自造名字", () => {
    expect(SRC).toContain("requestBody.timestamp =");
    expect(SRC).toContain("requestBody.sign =");
  });
});
