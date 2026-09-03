/**
 * 驾驶舱四屏装配（D50）：只装配、不重算；块状态五态；金额块按角色 no_access；
 * 未合并领域的块标 pending_domain 而不是 0。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { getCockpit } from "@/server/modules/report/cockpit";

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
      expect(a.screens.alerts.inventoryAlerts.state).toBe("pending_domain");
      expect(a.screens.alerts.salesSpike.state).toBe("pending_domain");
      expect(a.screens.inventory.transferLanes.state).toBe("pending_domain");
      expect(a.screens.ops.todo.state).toBe("pending_domain");
      expect(a.screens.ops.conclusions).toHaveLength(4);
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
