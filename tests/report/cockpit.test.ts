/**
 * 驾驶舱四屏装配（D50）：只装配、不重算；块状态五态；金额块按角色 no_access；
 * 未合并领域的块标 pending_domain 而不是 0。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { getCockpit, otifRatePctOf } from "@/server/modules/report/cockpit";

describe("驾驶舱四屏装配", () => {
  it("空库：四屏齐全、待接入块明确、金额块对仓库角色 no_access、对管理员可读", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const [wh] = await db.insert(schema.users).values({ name: "仓管", roles: ["warehouse"] }).returning();
      const a = await getCockpit({ id: admin.id, name: admin.name, roles: ["admin"], isApprover: true, channelScope: null }, db);
      expect(Object.keys(a.screens)).toEqual(["sources", "alerts", "inventory", "ops"]);
      expect(a.screens.sources.position.state).toBe("ready");
      expect(a.screens.sources.dataSources.state).toBe("ready");
      expect(["ready", "insufficient"]).toContain(a.screens.alerts.inventoryAlerts.state);
      expect(["ready", "insufficient"]).toContain(a.screens.alerts.salesSpike.state);
      // 全部块已接入：空库下为 insufficient / ready，绝不能是 pending_domain 或 error（allSettled 把单块错误隔离，但空库不该有错）
      for (const b of [a.screens.alerts.orders, a.screens.inventory.transferLanes, a.screens.inventory.transferAnomalies, a.screens.inventory.turnover, a.screens.ops.todo, a.screens.ops.goals, a.screens.ops.dataQuality]) {
        expect(["ready", "insufficient"], b.note).toContain(b.state);
      }
      expect(a.screens.ops.conclusions).toHaveLength(4);
      // UX 走查：截断表带总数；队列失败为 null 而不是 0；OTIF 由服务端折成百分数字符串
      if (a.screens.alerts.salesSpike.data) {
        expect(a.screens.alerts.salesSpike.data.hitCount).toBeGreaterThanOrEqual(a.screens.alerts.salesSpike.data.hits.length);
        expect(a.screens.alerts.salesSpike.data.unmappedCount).toBeGreaterThanOrEqual(a.screens.alerts.salesSpike.data.unmappedHits.length);
      }
      if (a.screens.alerts.inventoryAlerts.data) expect(a.screens.alerts.inventoryAlerts.data.alertRowCount).toBeGreaterThanOrEqual(a.screens.alerts.inventoryAlerts.data.rows.length);
      if (a.screens.inventory.warehouses.data) expect(a.screens.inventory.warehouses.data.rowCount).toBeGreaterThanOrEqual(a.screens.inventory.warehouses.data.rows.length);
      if (a.screens.inventory.turnover.data) {
        expect(a.screens.inventory.turnover.data.rows.every((r) => r.accountingMode === "realtime")).toBe(true);
        expect(a.screens.inventory.turnover.data.rows.length).toBeLessThanOrEqual(8);
      }
      if (a.screens.ops.goals.data) expect(a.screens.ops.goals.data.rowCount).toBeGreaterThanOrEqual(a.screens.ops.goals.data.rows.length);
      expect(a.screens.ops.queues.state).toBe("ready");
      expect(a.screens.ops.queues.data).toMatchObject({ inboxPending: 0, reviewOpen: 0, errors: { inbox: null, review: null } });
      if (a.screens.alerts.orders.data) {
        const o = a.screens.alerts.orders.data;
        // 空库无 OTIF 可评 → null（前端显示「不可评」），绝不是 "0.0" 或 0.83 式的比例
        expect(o.otifRatePct).toBe(o.orderSystem.otifRate == null ? null : otifRatePctOf(o.orderSystem.otifRate));
        if (o.otifRatePct != null) expect(o.otifRatePct).toMatch(/^\d+(\.\d)?$/);
      }
      // 红卡条永远含爆单与断货两项（待接入时 count=0 但不消失）
      expect(a.screens.alerts.redline.map((r) => r.key)).toEqual(expect.arrayContaining(["sales_spike", "inventory_cover"]));
      // 管理员：占比块存在（无销售金额 → insufficient 而不是报错）
      expect(["ready", "insufficient"]).toContain(a.screens.sources.ratio.state);
      expect(a.screens.sources.salesAmount.state).toBe("insufficient");
      expect(a.topbar.scopeLabel).toBe("范围：全渠道");

      const w = await getCockpit({ id: wh.id, name: wh.name, roles: ["warehouse"], isApprover: false, channelScope: null }, db);
      expect(w.screens.sources.ratio.state).toBe("no_access");
      expect(w.screens.sources.salesAmount.state).toBe("no_access");
      expect(w.screens.sources.position.state).toBe("ready");
    } finally {
      await client.close();
    }
  });

  it("OTIF 比例 → 百分数字符串：0.8333 → 83.3（审计 #1：曾显示成 0.83%）；null / 非数保持 null", () => {
    expect(otifRatePctOf(0.8333)).toBe("83.3");
    expect(otifRatePctOf("0.8333")).toBe("83.3");
    expect(otifRatePctOf(1)).toBe("100.0");
    expect(otifRatePctOf(0)).toBe("0.0");
    expect(otifRatePctOf(null)).toBeNull();
    expect(otifRatePctOf(undefined)).toBeNull();
    expect(otifRatePctOf("n/a")).toBeNull();
    expect(`OTIF ${otifRatePctOf(0.83)}%`).toBe("OTIF 83.0%");
  });

  it("受限渠道运营：顶栏显示渠道范围", async () => {
    const { db, client } = await createTestDb();
    try {
      const [ops] = await db.insert(schema.users).values({ name: "天猫运营", roles: ["ops"] }).returning();
      const c = await getCockpit({ id: ops.id, name: ops.name, roles: ["ops"], isApprover: false, channelScope: [1] }, db);
      expect(c.topbar.scopeLabel).toContain("渠道 1");
      expect(c.screens.sources.ratio.state).toBe("no_access");
    } finally {
      await client.close();
    }
  });
});
