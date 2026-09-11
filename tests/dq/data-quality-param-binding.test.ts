/**
 * 数据质量读模型缓存的**参数绑定**（2026-09-04 审计 #6）。
 *
 * 事故形态：绑定串只写了 `(SELECT max(id) FROM sys_params)`，而 `updateParam` 走
 * `onConflictDoUpdate`——改一个阈值不会产生新 id。于是业务在运行参数页把
 * 「快照总量跳变阈值」从 30 调到 5，`/report/data-quality` 依然命中旧缓存，
 * 页面上的例外数一动不动，看上去像"改了没用"。此前只有 `dq_tolerance_pct` 被显式绑定。
 *
 * 本测试逐个证明：本读模型实际读取的每个参数，改值都会改变绑定串。
 */
import { describe, expect, it } from "vitest";
import { sysParams } from "@/db/schema";
import { clearParamCache } from "@/server/core/params";
import { DQ_BINDING_PARAM_KEYS, dataQualityBinding } from "@/server/modules/report/data-quality";
import { createTestDb } from "../helpers/db";

const TODAY = "2026-09-04";

async function setParam(db: Awaited<ReturnType<typeof createTestDb>>["db"], key: string, value: string) {
  await db
    .insert(sysParams)
    .values({ scope: "global", key, value, note: key })
    .onConflictDoUpdate({ target: [sysParams.scope, sysParams.key], set: { value } });
  clearParamCache();
}

describe("data-quality/v2 绑定串按参数当前值失效", () => {
  it("绑定串登记的键覆盖 D65 的五个阈值 + 一致容差", () => {
    expect([...DQ_BINDING_PARAM_KEYS]).toEqual([
      "dq_tolerance_pct",
      "dq_snapshot_qty_jump_pct",
      "dq_snapshot_vanished_pct",
      "dq_sales_consistency_rel_pct",
      "dq_sales_consistency_abs_floor_qty",
      "dq_sales_consistency_min_base_qty",
    ]);
  });

  it.each([...DQ_BINDING_PARAM_KEYS])("改 %s 的值 → 绑定串必须变（不能只绑 max(id)）", async (key) => {
    const { db } = await createTestDb();
    const before = await dataQualityBinding(db, TODAY);
    // 先写一次（产生行、推高 max(id)），再改值——第二次改值不产生新 id，正是事故场景
    await setParam(db, key, "7");
    const afterInsert = await dataQualityBinding(db, TODAY);
    await setParam(db, key, "9");
    const afterUpdate = await dataQualityBinding(db, TODAY);

    expect(afterInsert, `${key} 首次写入未改变绑定`).not.toBe(before);
    expect(afterUpdate, `${key} 改值（同 id）未改变绑定——缓存会把新阈值藏起来`).not.toBe(afterInsert);
    expect(afterUpdate).toContain(":9");
  });

  it("同一份数据、同一天、参数未变 → 绑定串稳定（否则缓存永远失效）", async () => {
    const { db } = await createTestDb();
    expect(await dataQualityBinding(db, TODAY)).toBe(await dataQualityBinding(db, TODAY));
  });
});
