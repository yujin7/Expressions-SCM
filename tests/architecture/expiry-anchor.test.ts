/**
 * 架构护栏：效期剩余天数必须走 `core/stock-view.daysLeftOf`，
 * 禁止在业务代码里自己拿 `expiryDate` 做 Date 运算。
 *
 * 事故背景（2026-07-26 审计）：驾驶舱 `dashboard.ts` 用 `new Date()`（当前**时刻**）
 * 去减到期日午夜，而效期页 / 风险页 / 迷你360 都是**午夜减午夜**。差值恒定为 1 天：
 *
 *   午夜锚点：round((到期日午夜 − 今日午夜)/24h)              = N
 *   此刻锚点：floor((到期日午夜 − 此刻)/24h) = floor(N − t/24) = N − 1（t>0）
 *
 * 于是「明天才到期」的批次在驾驶舱显示 0 天，并因首桶判据 `daysLeft <= 0`
 * 被计进「已过期」与 expiryRiskQty——同一批货在两个页面上是两个结论。
 *
 * 为什么必须静态守：
 * ① 白天复现、午夜消失，跑一次测试很可能恰好是对的；
 * ② 全仓当时**没有任何 dashboard 测试**，行为测试成本高、覆盖不到这一行；
 * ③ 这是「同一个数两处算法」的口径漂移，本仓最贵的一类缺陷。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SERVER = path.resolve(__dirname, "../../src/server");
/** 唯一允许定义日差公式的地方 */
const ALLOW = [path.join("core", "stock-view.ts")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("架构护栏：效期天数锚点唯一", () => {
  it("**禁止对 expiryDate 自己做 Date 运算**——必须调 daysLeftOf", () => {
    const offenders: string[] = [];
    for (const file of walk(SERVER)) {
      const rel = path.relative(SERVER, file);
      if (ALLOW.includes(rel)) continue;
      const src = readFileSync(file, "utf8");
      // 命中形态：把 expiryDate 塞进 Date.parse / new Date 再做减法
      const lines = src.split("\n");
      lines.forEach((l, i) => {
        if (!l.includes("expiryDate")) return;
        const local = /(Date\.parse\(|new Date\()/.test(l) && /86_?400_?000/.test(l + (lines[i + 1] ?? ""));
        if (local) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `以下位置自行计算效期天数，会与其余页面差 1 天：\n${offenders.join("\n")}\n` +
        `改用 daysLeftOf(today, expiryDate) —— src/server/core/stock-view.ts`,
    ).toEqual([]);
  });

  it("**驾驶舱的效期天数不得由「此刻」推导**（它没有行为测试兜底）", () => {
    const src = readFileSync(path.join(SERVER, "modules/report/dashboard.ts"), "utf8");
    const bad = src
      .split("\n")
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /daysLeft\s*=/.test(l) && /today\.getTime\(\)|Date\.now\(\)/.test(l));
    expect(bad.map((b) => `dashboard.ts:${b.i}`), "daysLeft 必须来自 daysLeftOf(日期串)").toEqual([]);
    expect(src).toContain("daysLeftOf(");
  });

  it("daysLeftOf 是全站唯一实现，且已被真正采用（不是写了没人用）", () => {
    const users = walk(SERVER).filter((f) => {
      const rel = path.relative(SERVER, f);
      return !ALLOW.includes(rel) && /daysLeftOf\(/.test(readFileSync(f, "utf8"));
    });
    // 审计时它是零导入的孤儿；收口后至少这四处在用
    expect(users.length).toBeGreaterThanOrEqual(4);
  });
});
