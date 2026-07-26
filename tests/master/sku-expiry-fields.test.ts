import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skuSchema } from "@/server/modules/master/schemas";

/**
 * 效期两参必须有写入路径。
 *
 * 事故背景（2026-07-25 审计）：`skus` 表有 shelf_life_days / near_expiry_days 两列，
 * 且有活代码读它们——`matflow/sh.ts` 的「管效期 SKU 收货必填批次号」硬闸把
 * nearExpiryDays 当唯一开关——但**全系统没有任何写入路径**：
 * zod skuSchema 无此键、create/updateSku 白名单不含、放行引擎只写 shelf_life_days、无 UI/API。
 * 实测 near_expiry_days 0/5376 非空 ⇒ 那道合规硬闸结构性不可达，一单也拦不住，
 * 而读代码的人会以为效期收货已经受控。
 *
 * zod 白名单是这条链最容易被静默掐断的一环（字段没进 schema，parse 后就消失，
 * 后面 values 里写了也没用），所以护栏立在这里。
 */
describe("SKU 效期两参的写入路径", () => {
  const base = {
    code: "TEST-001",
    name: "测试品",
    spuId: 1,
    skuType: "finished" as const,
    baseUom: "个",
  };

  it("skuSchema 接受并透传 shelfLifeDays / nearExpiryDays", () => {
    const v = skuSchema.parse({ ...base, shelfLifeDays: 1095, nearExpiryDays: 219 });
    expect(v.shelfLifeDays).toBe(1095);
    expect(v.nearExpiryDays).toBe(219);
  });

  it("留空＝不设定（沿用兜底 90 天），不因此报错", () => {
    const v = skuSchema.parse(base);
    expect(v.shelfLifeDays ?? null).toBeNull();
    expect(v.nearExpiryDays ?? null).toBeNull();
  });

  it("拒绝 0 与负数（天数必须为正，否则硬闸判定会退化）", () => {
    expect(() => skuSchema.parse({ ...base, nearExpiryDays: 0 })).toThrow();
    expect(() => skuSchema.parse({ ...base, shelfLifeDays: -1 })).toThrow();
  });

  it("createSku / updateSku 的白名单确实写这两列（字段进了 schema 却没进 values 等于白搭）", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../src/server/modules/master/sku.ts"),
      "utf8",
    );
    // insert 的 values 与 update 的 set 各一处
    expect(src.match(/shelfLifeDays:\s*v\.shelfLifeDays/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src.match(/nearExpiryDays:\s*v\.nearExpiryDays/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
