import { beforeAll, describe, expect, it } from "vitest";
import { approvalConfigs, skus, spus, stockDocs, users, warehouses } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { approveStockDoc, createStockDoc, submitStockDoc } from "@/server/modules/inventory/stock-doc";
import type { SessionUser } from "@/server/core/dto";

/** 体检审计 #2 整改验证：期初单走独立 'opening' 审批配置（生产=财务），仓管不可审期初 */
describe("期初审批角色映射（opening→finance）", () => {
  let db: TestDb;
  let creator: SessionUser;
  let whApprover: SessionUser;
  let finApprover: SessionUser;
  let wh1: number;
  let sku1: number;

  const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
    const [u] = await db.insert(users).values({ name, roles, isApprover, username: name }).returning();
    return { id: u.id, name: u.name, roles, isApprover };
  };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "finance" }, // 生产语义（《01》§6：期初=财务）
    ]);
    creator = await mkUser("仓管制单", ["warehouse"], true);
    whApprover = await mkUser("仓管审批", ["warehouse"], true);
    finApprover = await mkUser("财务审批", ["finance"], true);
    const [spu] = await db.insert(spus).values({ code: "P90001", nameCn: "映射测试品" }).returning();
    const [sk] = await db.insert(skus).values({ code: "MAP0001", name: "映射SKU", spuId: spu.id, baseUom: "个", skuType: "packaging" }).returning();
    sku1 = sk.id;
    const [wh] = await db.insert(warehouses).values({ code: "WH-MAP", name: "映射仓", kind: "packaging" }).returning();
    wh1 = wh.id;
  });

  it("仓管审批期初 → ROLE_FORBIDDEN；财务审批 → 过账完成", async () => {
    const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: wh1, lines: [{ skuId: sku1, qty: "10", price: "1.00" }] }, db);
    const pending = await submitStockDoc(creator, doc.id, doc.version, db);
    await expect(
      approveStockDoc(whApprover, pending.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ status: 403 });
    const [still] = await db.select().from(stockDocs);
    expect(still.status).toBe("pending");
    const r = await approveStockDoc(finApprover, pending.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
  });
});
