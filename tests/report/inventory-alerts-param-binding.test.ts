/**
 * 库存预警读模型的**来源绑定必须带上运行参数**（`INVENTORY_ALERTS_BINDING_PARAM_KEYS`）。
 *
 * 事故形态：binding() 只带事实表的 max(id)/max(built_at) 与业务日。
 * PMC 在 /admin/params 把 `alert_buffer_days` 从 5 改成 10，阈值随即变了，
 * 但 source_binding 一模一样 → 缓存命中旧结论，预警要等到某张事实表**恰好**变动才重算。
 * 读模型的绑定必须覆盖它读到的**每一样输入**。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import {
  computeInventoryAlerts,
  INVENTORY_ALERTS_BINDING_PARAM_KEYS,
} from "@/server/modules/report/inventory-alerts";
import { PARAM_DEFS } from "@/server/modules/admin/params";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src/server/modules/report/inventory-alerts.ts");

describe("inventory-alerts：来源绑定覆盖运行参数", () => {
  it("清单等于文件里实际 getNumParam 读的参数键集合（不漏、不多）", () => {
    const src = readFileSync(SRC, "utf8");
    const actual = new Set([...src.matchAll(/getNumParam\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
    expect(new Set(INVENTORY_ALERTS_BINDING_PARAM_KEYS)).toEqual(actual);
  });

  /* 说明：`alert_learned_lead_tolerance_days` 目前**未**登记进 PARAM_DEFS（学习交期仍只观察，
     阈值不下放给业务改）——这是既有状态，本文件只如实钉住「页面可改的那些必须在绑定里」，
     不顺手改 /admin/params 的白名单。 */
  it("凡登记进 PARAM_DEFS（业务可改）的绑定参数键，都必须逐键出现在绑定串里", async () => {
    const { db } = await createTestDb();
    const binding = (await computeInventoryAlerts(db)).sourceBinding;
    const writable = INVENTORY_ALERTS_BINDING_PARAM_KEYS.filter((k) => PARAM_DEFS.some((d) => d.key === k));
    expect(writable.length).toBeGreaterThan(0);
    for (const key of writable) expect(binding, key).toContain(`${key}=`);
  });

  it("改一个参数值 → sourceBinding 必须变（否则缓存把旧结论藏起来）", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(schema.spus).values({ code: "PB1", nameCn: "绑定测试" }).returning();
    await db.insert(schema.skus).values({
      code: "BND001", name: "绑定测试成品", spuId: spu.id, skuType: "finished", baseUom: "支",
    });

    const before = (await computeInventoryAlerts(db)).sourceBinding;
    expect(before).toContain("params:");
    expect(before).toContain("alert_buffer_days=default");

    await db.insert(schema.sysParams).values({ scope: "global", key: "alert_buffer_days", value: "10" });
    const after = (await computeInventoryAlerts(db)).sourceBinding;
    expect(after).not.toBe(before);
    expect(after).toContain("alert_buffer_days=10");
  });
});
