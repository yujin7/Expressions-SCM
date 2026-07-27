import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  binBalances,
  bins,
  skus,
  spus,
  stockBalances,
  users,
  warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createBin, updateBin } from "@/server/modules/master/bin";
import { updateWarehouse } from "@/server/modules/master/warehouse";
import { createTestDb } from "../helpers/db";

describe("仓库与库位主数据约束", () => {
  it("仓库区域与记账分类在数据库边界一致", async () => {
    const { db } = await createTestDb();
    await expect(db.insert(warehouses).values({
      code: "BAD-REGION",
      name: "错误区域",
      kind: "finished",
      regionCode: "china",
    })).rejects.toThrow();
    await expect(db.insert(warehouses).values({
      code: "BAD-TAXONOMY",
      name: "错误记账",
      kind: "snapshot",
      accountingMode: "realtime",
    })).rejects.toThrow();
    const [valid] = await db.insert(warehouses).values({
      code: "HK-RT",
      name: "香港实时仓",
      kind: "finished",
      regionCode: "HK",
      accountingMode: "realtime",
    }).returning();
    expect(valid.regionCode).toBe("HK");

    const preserved = await updateWarehouse(valid.id, {
      code: valid.code,
      name: "香港实时仓（改名）",
      kind: valid.kind,
      active: true,
    }, undefined, db);
    expect(preserved.regionCode).toBe("HK");
  });

  it("只允许实时仓建库位，并与审计同事务落地", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(users).values({ name: "仓管", roles: ["warehouse"] }).returning();
    const actor: SessionUser = { id: user.id, name: user.name, roles: ["warehouse"], isApprover: false };
    const [realtime, snapshot] = await db.insert(warehouses).values([
      { code: "BIN-RT", name: "实时仓", kind: "finished", accountingMode: "realtime" },
      { code: "BIN-SNAP", name: "快照仓", kind: "snapshot", accountingMode: "snapshot" },
    ]).returning();

    const created = await createBin({
      warehouseId: realtime.id,
      code: "A-01",
      name: "拣货位",
      kind: "normal",
      active: true,
    }, actor, db);
    expect(created).toMatchObject({ warehouseId: realtime.id, code: "A-01", kind: "normal" });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entity, "bin"));
    expect(audit).toMatchObject({ entityId: created.id, action: "create", userId: actor.id });

    await expect(createBin({
      warehouseId: snapshot.id,
      code: "NOPE",
      kind: "normal",
      active: true,
    }, actor, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("快照仓") });
  });

  it("有正库存的库位不能停用、改用途或改所属仓", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(users).values({ name: "仓管", roles: ["warehouse"] }).returning();
    const actor: SessionUser = { id: user.id, name: user.name, roles: ["warehouse"], isApprover: false };
    const [warehouse] = await db.insert(warehouses).values({ code: "BIN-WH-LOCK", name: "锁定测试仓", kind: "finished" }).returning();
    const [otherWarehouse] = await db.insert(warehouses).values({ code: "BIN-WH-OTHER", name: "另一仓", kind: "finished" }).returning();
    const [spu] = await db.insert(spus).values({ code: "BIN-M-SPU", nameCn: "测试" }).returning();
    const [sku] = await db.insert(skus).values({
      spuId: spu.id,
      code: "BIN-M-SKU",
      name: "测试",
      skuType: "finished",
      baseUom: "件",
    }).returning();
    const [bin] = await db.insert(bins).values({ warehouseId: warehouse.id, code: "A-01", kind: "normal" }).returning();
    await db.insert(binBalances).values({ binId: bin.id, skuId: sku.id, qty: "1" });

    await expect(updateBin(bin.id, {
      warehouseId: warehouse.id,
      code: bin.code,
      name: bin.name,
      kind: bin.kind,
      active: false,
      remark: bin.remark,
    }, actor, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("正库存") });
    await expect(updateBin(bin.id, {
      warehouseId: warehouse.id,
      code: bin.code,
      name: bin.name,
      kind: "quarantine",
      active: true,
      remark: bin.remark,
    }, actor, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("用途") });
    await expect(updateBin(bin.id, {
      warehouseId: otherWarehouse.id,
      code: bin.code,
      name: bin.name,
      kind: bin.kind,
      active: true,
      remark: bin.remark,
    }, actor, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("所属仓库") });
    expect((await db.select().from(bins).where(eq(bins.id, bin.id)))[0].active).toBe(true);
  });

  it("有库存事实的仓库不能在实时账与快照参考间改型", async () => {
    const { db } = await createTestDb();
    const [warehouse] = await db.insert(warehouses).values({
      code: "WH-MODE-LOCK",
      name: "模式锁定仓",
      kind: "finished",
      accountingMode: "realtime",
    }).returning();
    const [spu] = await db.insert(spus).values({ code: "WH-MODE-SPU", nameCn: "测试" }).returning();
    const [sku] = await db.insert(skus).values({
      spuId: spu.id,
      code: "WH-MODE-SKU",
      name: "测试",
      skuType: "finished",
      baseUom: "件",
    }).returning();
    await db.insert(stockBalances).values({ warehouseId: warehouse.id, skuId: sku.id, qty: "1" });

    await expect(updateWarehouse(warehouse.id, {
      code: warehouse.code,
      name: warehouse.name,
      kind: "snapshot",
      regionCode: "CN",
      active: true,
    }, undefined, db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("不能切换记账模式"),
    });
    expect((await db.select().from(warehouses).where(eq(warehouses.id, warehouse.id)))[0].accountingMode).toBe("realtime");
  });
});
