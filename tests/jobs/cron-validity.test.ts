/**
 * 每条 cron 都必须能被 pg-boss 实际使用的解析器解析。
 *
 * 为什么值得单独钉住：`SCHEDULES` 是手写的字符串表，写错一个字段
 * （多一段、小时写成 24、逗号写成分号）不会有编译错误，也不会抛异常——
 * **pg-boss 只是不登记那条任务，然后它永远不跑**。这是静默失败：
 * 页面正常、测试全绿、日志无异常，只有"数据怎么一直不更新"这一个症状，
 * 而那时通常已经过了好几天。
 *
 * 用 cron-parser 直接验证（pg-boss 自身依赖的就是它），并顺带断言下一次触发
 * 落在预期的上海时段，防止有人把小时字段改成 UTC 口径。
 */
import { describe, expect, it } from "vitest";
import parser from "cron-parser";
import { SCHEDULES } from "@/jobs/scheduler";

describe("cron 表达式有效性", () => {
  it("每条 cron 都能被解析（写错只会静默不登记，不会报错）", () => {
    const broken: string[] = [];
    for (const [name, expr] of Object.entries(SCHEDULES)) {
      try {
        parser.parseExpression(expr, { tz: "Asia/Shanghai" });
      } catch (error) {
        broken.push(`${name} → "${expr}"：${(error as Error).message}`);
      }
    }
    expect(
      broken,
      `以下 cron 无法解析，pg-boss 会静默跳过、任务永远不跑：\n${broken.join("\n")}`,
    ).toEqual([]);
  });

  it("字段数正确（5 段），不含秒级字段", () => {
    const wrong = Object.entries(SCHEDULES)
      .filter(([, expr]) => expr.trim().split(/\s+/).length !== 5)
      .map(([name, expr]) => `${name} → "${expr}"`);
    expect(wrong, `cron 应为 5 段（分 时 日 月 周）：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("同步批次的下一次触发确实落在上海 10/16 点", () => {
    // 从上海时间 2026-08-04 08:00 起算
    const from = new Date("2026-08-04T00:00:00Z"); // 上海 08:00
    for (const name of ["sync-yonyou", "sync-jst-sales", "sync-jiandaoyun-forms"]) {
      const next = parser
        .parseExpression(SCHEDULES[name], { tz: "Asia/Shanghai", currentDate: from })
        .next()
        .toDate();
      const hour = Number(new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false,
      }).format(next));
      expect(hour, `${name} 下一次应落在上海 10 点`).toBe(10);
    }
  });

  it("下游告警的下一次触发落在上海 11 点，确实排在拉数之后", () => {
    const from = new Date("2026-08-04T00:00:00Z"); // 上海 08:00
    for (const name of ["system-alert-notify", "notify-dispatch", "snapshot-age"]) {
      const next = parser
        .parseExpression(SCHEDULES[name], { tz: "Asia/Shanghai", currentDate: from })
        .next()
        .toDate();
      const hour = Number(new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false,
      }).format(next));
      expect(hour, `${name} 下一次应落在上海 11 点`).toBe(11);
    }
  });
});
