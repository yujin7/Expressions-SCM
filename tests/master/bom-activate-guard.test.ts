import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, bomLines, boms, skus, spus, stockBalances, suppliers, users, warehouses } from "@/db/schema";
import type { DB } from "@/db";
import { activateBom } from "@/server/modules/master/bom";
import { createTestDb, type TestDb } from "../helpers/db";

describe("FEATURE 5 BOM 生效动效检查：被移除物料在委外仓有结存 → 409 / force 放行", () => {
  let db: TestDb;
  let dbx: DB;
  let productId = 0;
  let mA = 0;
  let mB = 0;
  let v2 = 0;
  let approver: { id: number; roles: string[]; isApprover: boolean };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    dbx = db as unknown as DB;
    const [u] = await db.insert(users).values({ name: "PMC审批", roles: ["pmc"], isApprover: true }).returning();
    approver = { id: u.id, roles: ["pmc"], isApprover: true };

    const [spu] = await db.insert(spus).values({ code: "PAG01", nameCn: "动效测试品" }).returning();
    const mk = async (code: string, type: "finished" | "raw") => {
      const [s] = await db.insert(skus).values({ code, name: code, spuId: spu.id, baseUom: "个", skuType: type }).returning();
      return s.id;
    };
    productId = await mk("AG-P1", "finished");
    mA = await mk("AG-MA", "raw");
    mB = await mk("AG-MB", "raw");

    const [sup] = await db.insert(suppliers).values({ code: "GAG1", name: "动效工厂", kinds: ["processor"] }).returning();
    const [wh] = await db
      .insert(warehouses)
      .values({ code: "WWX-AG", name: "动效委外仓", kind: "outsource", supplierId: sup.id })
      .returning();
    // 旧生效版本含 mA+mB；新草稿仅 mA（mB 被移除）
    const [b1] = await db.insert(boms).values({ productSkuId: productId, versionNo: "V1", status: "active" }).returning();
    await db.insert(bomLines).values([
      { bomId: b1.id, materialSkuId: mA, qtyPer: "1.0000", lossRatePct: "0" },
      { bomId: b1.id, materialSkuId: mB, qtyPer: "1.0000", lossRatePct: "0" },
    ]);
    const [b2] = await db.insert(boms).values({ productSkuId: productId, versionNo: "V2", status: "draft" }).returning();
    v2 = b2.id;
    await db.insert(bomLines).values([{ bomId: v2, materialSkuId: mA, qtyPer: "1.0000", lossRatePct: "0" }]);
    // 委外仓仍有 mB 结存（垫料/在制）——测试夹具直插余额（只读校验，不经过账引擎）
    await db.insert(stockBalances).values({ skuId: mB, warehouseId: wh.id, batchId: null, qty: "5.0000" });
  });

  it("默认拦截：409 且列出编码与整改指引", async () => {
    await expect(activateBom(v2, approver, { db: dbx })).rejects.toThrow(
      /AG-MB.*在委外仓仍有结存.*请先核对物料流再生效.*备注注明后重试/,
    );
    const [still] = await db.select().from(boms).where(eq(boms.id, v2));
    expect(still.status).toBe("draft"); // 事务回滚，未切版
  });

  it("force=true 显式放行：生效成功 + activate_forced 审计", async () => {
    const updated = await activateBom(v2, approver, { force: true, db: dbx });
    expect(updated.status).toBe("active");
    const [old] = await db
      .select()
      .from(boms)
      .where(and(eq(boms.productSkuId, productId), eq(boms.versionNo, "V1")));
    expect(old.status).toBe("retired");
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "bom"), eq(auditLogs.action, "activate_forced")));
    expect(audits).toHaveLength(1);
    expect((audits[0].after as { stuckCodes: string[] }).stuckCodes).toEqual(["AG-MB"]);
  });

  it("移除物料无委外结存时不拦截", async () => {
    // V3 移除 mA（mA 无委外结存）——直接生效成功
    const [b3] = await db.insert(boms).values({ productSkuId: productId, versionNo: "V3", status: "draft" }).returning();
    await db.insert(bomLines).values([{ bomId: b3.id, materialSkuId: mB, qtyPer: "1.0000", lossRatePct: "0" }]);
    const updated = await activateBom(b3.id, approver, { db: dbx });
    expect(updated.status).toBe("active");
  });
});
