/**
 * 单据/流水列表的日期窗口：非法日期串必须 400，不得静默返回全量。
 *
 * 事故形状：`createdWithinShanghaiDays` 原注释写着「非法日期串直接忽略（不猜、不 500）」。
 * 忽略比 500 更糟——用户筛了区间、串写错了，拿回来的是**整张未筛选的列表**，
 * 而界面看起来就像筛选生效了：一个安静的错误答案，没有任何迹象提示它是错的。
 * 而且旧写法连「不 500」都没做到：`/^\d{4}-\d{2}-\d{2}$/` 只验形状，
 * `"2026-13-45"` 照样进 SQL，`('2026-13-45')::date` 在 Postgres 炸成 500。
 *
 * 四个消费者共用这一个 helper（库存流水 / 备货申请 / 委外工单 / 收货单），
 * 修在 helper 里而不是四个调用点里——同一个洞补四次，早晚漏一次。
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { createdWithinShanghaiDays } from "@/server/core/doc-search";
import { ApiError } from "@/server/modules/master/common";

const col = sql`created_at`;

describe("单据日期窗口", () => {
  it("形状合法但日历上不存在的日期 → 400（此前原样进 SQL 炸成 500）", () => {
    expect(() => createdWithinShanghaiDays(col, "2026-13-45", undefined)).toThrow(ApiError);
    expect(() => createdWithinShanghaiDays(col, undefined, "2026-02-30")).toThrow(ApiError);
  });

  it("完全不像日期的串 → 400，**不是**静默返回全量", () => {
    let thrown: unknown;
    try {
      createdWithinShanghaiDays(col, "昨天", undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "静默丢掉筛选条件 = 把未筛选的全量当成筛选结果返回").toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(400);
    expect((thrown as ApiError).message).toContain("起始日期");
  });

  it("起止倒置 → 400（否则返回空集，读者会以为「这段时间真的没有单」）", () => {
    expect(() => createdWithinShanghaiDays(col, "2026-09-05", "2026-09-01")).toThrow(ApiError);
  });

  it("空串/未传 = 不设这一侧边界，不是错误（页面清空筛选就是这个形状）", () => {
    expect(createdWithinShanghaiDays(col, undefined, undefined)).toHaveLength(0);
    expect(createdWithinShanghaiDays(col, "", "")).toHaveLength(0);
    expect(createdWithinShanghaiDays(col, "2026-09-01", undefined)).toHaveLength(1);
    expect(createdWithinShanghaiDays(col, "2026-09-01", "2026-09-05")).toHaveLength(2);
  });

  it("完整时间戳也接受（归一成上海业务日），不是只认 YYYY-MM-DD", () => {
    expect(createdWithinShanghaiDays(col, "2026-09-04T16:30:00.000Z", undefined)).toHaveLength(1);
  });

  it("四个消费者都走本 helper，没有谁自己再拼一遍时间窗", () => {
    const consumers = [
      "src/server/modules/inventory/queries.ts",
      "src/server/modules/outsource/bh.ts",
      "src/server/modules/outsource/wo.ts",
      "src/server/modules/matflow/sh-read.ts",
    ];
    for (const f of consumers) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} 必须调用 createdWithinShanghaiDays`).toContain("createdWithinShanghaiDays(");
      expect(src, `${f} 不得自己拼 AT TIME ZONE 时间窗`).not.toMatch(/AT TIME ZONE 'Asia\/Shanghai'/);
    }
  });
});
