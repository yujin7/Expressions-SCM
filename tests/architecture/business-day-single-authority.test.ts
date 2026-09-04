/**
 * 日界（Asia/Shanghai 业务日）唯一权威守卫。
 *
 * 事故形状：`src/server/core/business-day.ts` 的模块头早就写明「日界换算曾在四处各写一份
 * `new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })`……四份实现今天恰好一致，
 * 但没有任何东西保证它们一起改」。收口之后**没有守卫**，于是又长回 29 份——分布在
 * report/、jobs/、integrations/、docflow/、db/seed 以及两个客户端组件里，其中
 * `report/supplier-scorecard.ts` 与 `report/leadtime-learning.ts` 的注释还互相写着「同准」，
 * 正是「靠注释维持口径」的典型。这与 2026-09-04 安全审计 S3（scoped-params 的权限表只在
 * 一层生效）是同一个形状：权威建了，但没有东西阻止旁路。
 *
 * 纪律：业务日/业务月/调度小时只能来自 `@/server/core/business-day`。
 * 展示用的 `toLocaleString("zh-CN", …)` 不在此列——那是给人看的字符串，不是业务键。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const AUTHORITY = join("src", "server", "core", "business-day.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

describe("业务日唯一权威", () => {
  it("除 core/business-day.ts 外，任何地方都不得自己造 Asia/Shanghai 的日期键格式化器", () => {
    const offenders = walk("src")
      .filter((f) => f !== AUTHORITY)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        /* 日期键的两种形态：en-CA 与 sv-SE 都输出 YYYY-MM-DD */
        return /new Intl\.DateTimeFormat\(\s*"(en-CA|sv-SE)"[\s\S]{0,200}?timeZone:\s*"Asia\/Shanghai"/.test(src)
          || /timeZone:\s*"Asia\/Shanghai"[\s\S]{0,200}?\}\s*\)\s*\.\s*format/.test(src)
            && /"(en-CA|sv-SE)"/.test(src);
      });
    expect(
      offenders,
      "业务日必须走 @/server/core/business-day（shanghaiDayOf / todayShanghai / shanghaiMonthOf / shanghaiHourKeyOf）",
    ).toEqual([]);
  });

  it("权威模块保持零依赖：它被 rules/、server/modules、src/jobs 同时引用，任何 import 都会顺三条线扩散", () => {
    const src = readFileSync(AUTHORITY, "utf8");
    expect(src.match(/^import .*/gm) ?? []).toEqual([]);
  });

  it("权威模块的日界与月界互相自洽（月 = 日的前 7 位，不是另算一次）", async () => {
    const { shanghaiDayOf, shanghaiMonthOf, shanghaiHourKeyOf } = await import("@/server/core/business-day");
    /* 上海 00:30 —— UTC 还停在前一天，本地时区解释会差一天 */
    const d = new Date("2026-09-04T16:30:00.000Z");
    expect(shanghaiDayOf(d)).toBe("2026-09-05");
    expect(shanghaiMonthOf(d)).toBe(shanghaiDayOf(d).slice(0, 7));
    expect(shanghaiHourKeyOf(d)).toEqual({ hour: 0, key: "2026-09-05T00" });
  });

  it("形状合法但日历上不存在的日期一律 null——不能原样放行进 SQL", async () => {
    const { shanghaiDay } = await import("@/server/core/business-day");
    /* 这三个都能通过 /^\d{4}-\d{2}-\d{2}$/。原样放行时 ('2026-13-45')::date 在 Postgres
       炸成 500，「用户把日期填错了」于是变成一条服务端错误并进 error_logs。 */
    expect(shanghaiDay("2026-13-45")).toBeNull();
    expect(shanghaiDay("2026-02-30")).toBeNull();
    expect(shanghaiDay("2026-00-10")).toBeNull();
    expect(shanghaiDay("2026-09-05")).toBe("2026-09-05");
    expect(shanghaiDay("2024-02-29"), "闰年 2 月 29 日是真实存在的日子").toBe("2024-02-29");
    expect(shanghaiDay("昨天")).toBeNull();
    expect(shanghaiDay(""), "空串＝不设边界，不是错误").toBeNull();
  });
});
