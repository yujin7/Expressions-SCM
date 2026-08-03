/**
 * 聚水潭 token 到期看门狗测试。
 *
 * 为什么值得一道看门狗：官方 token 默认 30 天过期，且**过期后刷新接口失效**，
 * 只能让商家重走授权。没有告警的话就是"授权当天好用、一个月后静默失效"。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { systemAlerts } from "@/db/schema";
import {
  jstTokenDaysRemaining,
  runJstTokenWatchdog,
} from "@/jobs/jst-token-watchdog";
import { createTestDb } from "../helpers/db";

const NOW = new Date("2026-09-01T00:00:00Z");

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { JST_ACCESS_TOKEN: "tok", ...overrides } as unknown as NodeJS.ProcessEnv;
}

describe("聚水潭 token 到期看门狗", () => {
  it("未配置 token 时不扰民（还没授权≠快过期）", async () => {
    const { db } = await createTestDb();
    const result = await runJstTokenWatchdog(db, {
      now: NOW,
      env: {} as unknown as NodeJS.ProcessEnv,
    });
    expect(result).toMatchObject({ status: "skipped", opened: 0 });
  });

  it("token 还早时不开告警", async () => {
    const { db } = await createTestDb();
    // 2 天前取得 → 还剩 28 天
    const result = await runJstTokenWatchdog(db, {
      now: NOW,
      env: env({ JST_TOKEN_OBTAINED_AT: "2026-08-30T00:00:00Z" }),
    });
    expect(result.daysRemaining).toBe(28);
    expect(result.opened).toBe(0);
    expect(await db.select().from(systemAlerts)).toHaveLength(0);
  });

  it("剩余不足 7 天开高优告警，并给出刷新命令", async () => {
    const { db } = await createTestDb();
    // 25 天前取得 → 还剩 5 天
    const result = await runJstTokenWatchdog(db, {
      now: NOW,
      env: env({ JST_TOKEN_OBTAINED_AT: "2026-08-07T00:00:00Z" }),
    });
    expect(result.daysRemaining).toBe(5);
    expect(result.opened).toBe(1);

    const [alert] = await db.select().from(systemAlerts);
    expect(alert.severity).toBe("high");
    expect(alert.title).toContain("5 天");
    expect(alert.detail).toContain("refresh-jst-token");
    expect(alert.detail, "必须说明过期后就只能重新授权").toContain("不能再刷新");
  });

  it("已过期时明确告知刷新无效、只能重新授权", async () => {
    const { db } = await createTestDb();
    // 40 天前 → 已过期
    const result = await runJstTokenWatchdog(db, {
      now: NOW,
      env: env({ JST_TOKEN_OBTAINED_AT: "2026-07-23T00:00:00Z" }),
    });
    expect(result.daysRemaining).toBeLessThan(0);
    const [alert] = await db.select().from(systemAlerts);
    expect(alert.title).toContain("已过期");
    expect(alert.detail).toContain("jst:auth-url");
  });

  it("不知道取得时刻本身就要告警——不能把「没法评估」当「没问题」", async () => {
    const { db } = await createTestDb();
    const result = await runJstTokenWatchdog(db, { now: NOW, env: env() });
    expect(result.opened).toBe(1);
    const [alert] = await db.select().from(systemAlerts);
    expect(alert.title).toContain("到期时间未知");
  });

  it("同一问题不重复开单（已有 open 告警时不再插）", async () => {
    const { db } = await createTestDb();
    const args = { now: NOW, env: env({ JST_TOKEN_OBTAINED_AT: "2026-08-07T00:00:00Z" }) };
    await runJstTokenWatchdog(db, args);
    const second = await runJstTokenWatchdog(db, args);
    expect(second.opened).toBe(0);
    expect(await db.select().from(systemAlerts)).toHaveLength(1);
  });

  it("刷新后自动关闭告警（系统自动，非人工裁决）", async () => {
    const { db } = await createTestDb();
    await runJstTokenWatchdog(db, {
      now: NOW,
      env: env({ JST_TOKEN_OBTAINED_AT: "2026-08-07T00:00:00Z" }),
    });
    // 刷新：取得时刻更新为今天
    const after = await runJstTokenWatchdog(db, {
      now: NOW,
      env: env({ JST_TOKEN_OBTAINED_AT: "2026-09-01T00:00:00Z" }),
    });
    expect(after.autoClosed).toBe(1);
    const [alert] = await db.select().from(systemAlerts).where(eq(systemAlerts.id, 1));
    expect(alert.status).toBe("resolved");
    expect(alert.autoResolved).toBe(true);
  });

  it("取得时刻非法时按未知处理，不静默通过", () => {
    expect(jstTokenDaysRemaining(
      env({ JST_TOKEN_OBTAINED_AT: "不是时间" }),
      NOW,
    )).toBeNull();
  });
});
