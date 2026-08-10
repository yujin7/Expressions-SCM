/**
 * 源时点取值纪律测试。
 *
 * 背景是真实脏数据：简道云 `Pdd_X.04_百亿报名记录` 最新时间为 2051-07-31、
 * `CW_A.05_dd_绍兴保税仓_保税订单` 为 2028-11-12（录入错误）。
 * 各同步器的 sourceAsOf 取"记录里最大更新时间"，一条 2051 就能把整批顶到 2051，
 * 而 month-close.ts 用 sourceAsOf 做月份区间 gte/lt 过滤——
 * 该批次会被**排除在每一个合法月份之外**，在月结证据里静默消失。
 */
import { describe, expect, it } from "vitest";
import { resolveSourceAsOf } from "@/server/integrations/source-time";

const NOW = new Date("2026-08-04T00:00:00Z");

describe("源时点：排除脏的未来日期", () => {
  it("正常数据取最大时点", () => {
    const r = resolveSourceAsOf(
      ["2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", "2026-06-01T00:00:00Z"],
      NOW,
    );
    expect(r.sourceAsOf).toBe("2026-08-01T00:00:00.000Z");
    expect(r.futureIgnored).toBe(0);
  });

  it("2051 的脏行被忽略，其余记录仍给出真实时点", () => {
    const r = resolveSourceAsOf(
      ["2026-07-30T00:00:00Z", "2051-07-31T00:00:00Z", "2026-08-01T00:00:00Z"],
      NOW,
    );
    expect(r.sourceAsOf, "不能被 2051 顶走").toBe("2026-08-01T00:00:00.000Z");
    expect(r.futureIgnored).toBe(1);
    expect(r.futureMax).toBe("2051-07-31T00:00:00.000Z");
  });

  it("被忽略的条数如实报出，不静默吞掉——源头脏数据要能被发现", () => {
    const r = resolveSourceAsOf(
      ["2028-11-12T00:00:00Z", "2051-07-31T00:00:00Z", "2026-01-01T00:00:00Z"],
      NOW,
    );
    expect(r.futureIgnored).toBe(2);
    expect(r.futureMax).toBe("2051-07-31T00:00:00.000Z");
  });

  it("不把未来时点钳到 now——那等于把脏数据伪装成刚更新", () => {
    const r = resolveSourceAsOf(["2051-07-31T00:00:00Z"], NOW);
    expect(r.sourceAsOf, "全是脏行时应返回 null，而非 now").toBeNull();
    expect(r.futureIgnored).toBe(1);
  });

  it("容差内的轻微超前仍然采纳（源系统按本地时区写入）", () => {
    // now + 12 小时，在 36 小时容差内
    const r = resolveSourceAsOf(["2026-08-04T12:00:00Z"], NOW);
    expect(r.sourceAsOf).toBe("2026-08-04T12:00:00.000Z");
    expect(r.futureIgnored).toBe(0);
  });

  it("刚好越过容差就判为未来", () => {
    // 36 小时容差 → now + 37 小时应被忽略
    const r = resolveSourceAsOf(["2026-08-05T13:00:00Z"], NOW);
    expect(r.sourceAsOf).toBeNull();
    expect(r.futureIgnored).toBe(1);
  });

  it("空值、非法字符串安全跳过，不抛错也不算作未来", () => {
    const r = resolveSourceAsOf([null, undefined, "", "不是时间", "2026-05-05T00:00:00Z"], NOW);
    expect(r.sourceAsOf).toBe("2026-05-05T00:00:00.000Z");
    expect(r.futureIgnored).toBe(0);
  });

  it("全空时返回 null", () => {
    expect(resolveSourceAsOf([], NOW)).toMatchObject({ sourceAsOf: null, futureIgnored: 0 });
  });
});
