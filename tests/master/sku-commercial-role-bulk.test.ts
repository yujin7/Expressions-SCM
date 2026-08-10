/**
 * 批量设置业务用途（小样打标）写路径。
 *
 * 背景：实跑库 5,376 个 SKU 全部停在 `unclassified`，而「未分类」在分析口径里
 * 按参与正常销售处理——0727 会议要的「小样独立统计、避免无动销失真」因此一直没生效。
 * 主档表单只能逐条改，BOM 批量放行路径根本不写这一列，所以必须有批量入口。
 *
 * 按写路径要求逐条钉住：全或无、幂等重放、逐 SKU 审计、非法取值与越界拒绝。
 */
import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { auditLogs, skus, spus, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { createSku, setSkuCommercialRoles } from "@/server/modules/master/sku";

async function setup() {
  const { db } = await createTestDb();
  const [user] = await db.insert(users).values({
    username: "bulk_role_actor",
    name: "主数据管理员",
    roles: ["pmc"],
    isApprover: false,
  }).returning();
  const actor = { id: user.id, name: user.name, roles: ["pmc"], isApprover: false };
  const [spu] = await db.insert(spus).values({ code: "P77001", nameCn: "测试成品" }).returning();
  const made = [];
  for (const n of [1, 2, 3]) {
    made.push(await createSku({
      name: `测试小样${n}`,
      spuId: spu.id,
      skuType: "finished",
      baseUom: "支",
      // 明确从"未分类"起步，复刻实跑库的真实起点
      commercialRole: "unclassified",
    }, actor, db));
  }
  return { db, actor, ids: made.map((m) => m.id) };
}

describe("批量设置业务用途", () => {
  it("整批更新并逐 SKU 写审计（同事务）", async () => {
    const { db, actor, ids } = await setup();
    const res = await setSkuCommercialRoles(ids, "sample", actor, db);
    expect(res).toEqual({ updated: 3, unchanged: 0, role: "sample" });

    const rows = await db.select().from(skus).where(inArray(skus.id, ids));
    expect(rows.every((r) => r.commercialRole === "sample")).toBe(true);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "set_commercial_role"));
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.userId === actor.id && l.entity === "sku")).toBe(true);
    // before/after 都要留痕，事后能追是谁把哪一批归成了样品
    const before = logs[0].before as { commercialRole?: string } | null;
    const after = logs[0].after as { commercialRole?: string } | null;
    expect(before?.commercialRole).toBe("unclassified");
    expect(after?.commercialRole).toBe("sample");
  });

  it("重放幂等：值相同不写库也不重复记审计", async () => {
    const { db, actor, ids } = await setup();
    await setSkuCommercialRoles(ids, "sample", actor, db);
    const again = await setSkuCommercialRoles(ids, "sample", actor, db);
    expect(again).toEqual({ updated: 0, unchanged: 3, role: "sample" });

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "set_commercial_role"));
    expect(logs).toHaveLength(3); // 没有第二轮
  });

  it("只改变化的行：混合批次里已是目标值的不重复记审计", async () => {
    const { db, actor, ids } = await setup();
    await setSkuCommercialRoles([ids[0]], "sample", actor, db);
    const mixed = await setSkuCommercialRoles(ids, "sample", actor, db);
    expect(mixed).toEqual({ updated: 2, unchanged: 1, role: "sample" });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "set_commercial_role"));
    expect(logs).toHaveLength(3); // 1 + 2，而不是 1 + 3
  });

  it("含不存在的 id 时整批回滚——不接受静默部分成功", async () => {
    const { db, actor, ids } = await setup();
    await expect(setSkuCommercialRoles([...ids, 999999], "sample", actor, db))
      .rejects.toThrow(/不存在/);
    const rows = await db.select().from(skus).where(inArray(skus.id, ids));
    expect(rows.every((r) => r.commercialRole === "unclassified"), "整批必须回滚").toBe(true);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "set_commercial_role"));
    expect(logs).toHaveLength(0);
  });

  it("非法取值、空选择与超量分批都被拒绝", async () => {
    const { db, actor, ids } = await setup();
    await expect(setSkuCommercialRoles(ids, "retail_typo" as never, actor, db))
      .rejects.toThrow(/业务用途取值非法/);
    await expect(setSkuCommercialRoles([], "sample", actor, db))
      .rejects.toThrow(/请先选择/);
    await expect(setSkuCommercialRoles(Array.from({ length: 2001 }, (_, i) => i + 1), "sample", actor, db))
      .rejects.toThrow(/最多设置 2000/);
  });

  it("重复 id 去重后按一个算，不会把同一行记两条审计", async () => {
    const { db, actor, ids } = await setup();
    const res = await setSkuCommercialRoles([ids[0], ids[0], ids[0]], "gift", actor, db);
    expect(res).toEqual({ updated: 1, unchanged: 0, role: "gift" });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "set_commercial_role"));
    expect(logs).toHaveLength(1);
  });
});
