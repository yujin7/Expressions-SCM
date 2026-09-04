/**
 * W2-6 批次级隔离 / 放行回归门。
 *
 * 修复前的状态：`bins.kind='quarantine'` 与 `bin_movements.operation='quarantine'|'release'`
 * 连同整套不变量守卫都已建好，但**只有按仓库逐行的库位作业页能用**。
 * 召回或检验不合格时，人手上拿到的是批次号，系统里没有任何按 (SKU, 批次) 找货并就地隔离的入口——
 * 于是这套能力从上线起就没被任何流程调用过。
 *
 * `listBatchPlacements` / `quarantineOrReleaseBatch` 在修复前不存在，下面每条断言都会失败。
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLogs, batches, binBalances, bins, skus, spus, stockBalances, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { listBatchPlacements, quarantineOrReleaseBatch } from "@/server/modules/inventory/bin-operations";
import { post } from "@/server/posting";
import { createTestDb, type TestDb } from "../helpers/db";

async function seed(db: TestDb, opts: { extraQuarantineBin?: boolean } = {}) {
  const [w] = await db.insert(users).values({ name: "仓管", roles: ["warehouse"] }).returning();
  const [f] = await db.insert(users).values({ name: "财务", roles: ["finance"] }).returning();
  const warehouseUser: SessionUser = { id: w.id, name: w.name, roles: ["warehouse"], isApprover: false };
  const financeUser: SessionUser = { id: f.id, name: f.name, roles: ["finance"], isApprover: false };

  const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
  const [sku] = await db
    .insert(skus)
    .values({ code: "CP00001", name: "测试成品", spuId: spu.id, baseUom: "个", skuType: "finished" })
    .returning();
  const [wh] = await db.insert(warehouses).values({ code: "WH-F", name: "成品仓", kind: "finished" }).returning();
  const [batch] = await db.insert(batches).values({ skuId: sku.id, batchNo: "B-CALL-001" }).returning();
  const [normalBin] = await db
    .insert(bins).values({ warehouseId: wh.id, code: "A-01", kind: "normal" }).returning();
  const [qBin] = await db
    .insert(bins).values({ warehouseId: wh.id, code: "Q-01", name: "隔离区", kind: "quarantine" }).returning();
  const extraQ = opts.extraQuarantineBin
    ? (await db.insert(bins).values({ warehouseId: wh.id, code: "Q-02", kind: "quarantine" }).returning())[0]
    : null;

  await post(db, {
    sourceDocType: "opening",
    sourceDocId: 1,
    action: "post",
    lines: [{ sourceLineId: 1, skuId: sku.id, warehouseId: wh.id, batchId: batch.id, qtyDelta: "100" }],
  });
  return { warehouseUser, financeUser, sku, wh, batch, normalBin, qBin, extraQ };
}

describe("W2-6 批次隔离 / 放行", () => {
  it("按 (SKU, 批次) 列出物理分布：全部未定位时给出一行「未定位」，并带出该仓可用库位", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const { rows, bins: binRows } = await listBatchPlacements({ skuId: s.sku.id, batchId: s.batch.id }, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      warehouseId: s.wh.id,
      warehouseName: "成品仓",
      binId: null,
      qty: "100.0000",
      locationState: "unlocated",
    });
    expect(binRows.map((b) => b.code).sort()).toEqual(["A-01", "Q-01"]);
  });

  it("隔离：未定位库存 → 隔离库位；目标唯一时可省略、写 bin_movements 并同事务写审计；仓库总账数量不变", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const before = await db.select().from(stockBalances);

    const result = await quarantineOrReleaseBatch(s.warehouseUser, {
      idempotencyKey: "quarantine-recall-0001",
      intent: "quarantine",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      qty: "40",
      reason: "批次召回：供应商通报原料异常",
    }, db);
    expect(result.idempotent).toBe(false);

    const [placed] = await db
      .select()
      .from(binBalances)
      .where(and(eq(binBalances.binId, s.qBin.id), eq(binBalances.batchId, s.batch.id)));
    expect(placed.qty).toBe("40.0000");

    // 仓库总账是数量真相：隔离只改「货在哪」
    expect(await db.select().from(stockBalances)).toEqual(before);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "bin_movement"), eq(auditLogs.action, "quarantine")));
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(s.warehouseUser.id);
    expect(audit[0].after).toMatchObject({ reason: "批次召回：供应商通报原料异常", qty: "40.0000" });

    // 分布视图随即反映隔离结果
    const { rows } = await listBatchPlacements({ skuId: s.sku.id, batchId: s.batch.id }, db);
    const byState = Object.fromEntries(rows.map((r) => [r.binCode ?? "未定位", r.qty]));
    expect(byState).toEqual({ "Q-01": "40.0000", 未定位: "60.0000" });
    expect(rows.find((r) => r.binCode === "Q-01")!.binKind).toBe("quarantine");
  });

  it("放行：隔离库位 → 普通库位，同样留原因与审计", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    await quarantineOrReleaseBatch(s.warehouseUser, {
      idempotencyKey: "quarantine-recall-0002",
      intent: "quarantine",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      qty: "40",
      reason: "待检",
    }, db);
    await quarantineOrReleaseBatch(s.warehouseUser, {
      idempotencyKey: "release-0002",
      intent: "release",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      fromBinId: s.qBin.id,
      qty: "15",
      reason: "复检合格，放行 15",
    }, db);

    const { rows } = await listBatchPlacements({ skuId: s.sku.id, batchId: s.batch.id }, db);
    const byBin = Object.fromEntries(rows.map((r) => [r.binCode ?? "未定位", r.qty]));
    expect(byBin).toEqual({ "A-01": "15.0000", "Q-01": "25.0000", 未定位: "60.0000" });
    const released = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "bin_movement"), eq(auditLogs.action, "release")));
    expect(released).toHaveLength(1);
  });

  it("幂等：同一 idempotencyKey 重放不重复扣减", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    const body = {
      idempotencyKey: "quarantine-idem-0003",
      intent: "quarantine" as const,
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      qty: "30",
      reason: "召回",
    };
    const first = await quarantineOrReleaseBatch(s.warehouseUser, body, db);
    const second = await quarantineOrReleaseBatch(s.warehouseUser, body, db);
    expect(second).toEqual({ id: first.id, idempotent: true });
    const [placed] = await db.select().from(binBalances).where(eq(binBalances.binId, s.qBin.id));
    expect(placed.qty).toBe("30.0000");
  });

  it("目标库位有歧义时不猜：多个隔离库位必须显式指定", async () => {
    const { db } = await createTestDb();
    const s = await seed(db, { extraQuarantineBin: true });
    await expect(quarantineOrReleaseBatch(s.warehouseUser, {
      idempotencyKey: "quarantine-ambiguous-1",
      intent: "quarantine",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      qty: "10",
      reason: "召回",
    }, db)).rejects.toThrow(/多个候选库位/);

    const ok = await quarantineOrReleaseBatch(s.warehouseUser, {
      idempotencyKey: "quarantine-ambiguous-2",
      intent: "quarantine",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      toBinId: s.extraQ!.id,
      qty: "10",
      reason: "召回",
    }, db);
    expect(ok.idempotent).toBe(false);
  });

  it("守卫仍然生效：非仓管被拒；超出可隔离量被拒；隔离目标必须是隔离库位", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    await expect(quarantineOrReleaseBatch(s.financeUser, {
      idempotencyKey: "quarantine-role-1",
      intent: "quarantine",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      qty: "10",
      reason: "召回",
    }, db)).rejects.toThrow(/仅仓管或管理员/);

    await expect(quarantineOrReleaseBatch(s.warehouseUser, {
      idempotencyKey: "quarantine-overdraw-1",
      intent: "quarantine",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      qty: "101",
      reason: "召回",
    }, db)).rejects.toThrow(/未定位库存不足/);

    await expect(quarantineOrReleaseBatch(s.warehouseUser, {
      idempotencyKey: "quarantine-wrongbin-1",
      intent: "quarantine",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      toBinId: s.normalBin.id,
      qty: "10",
      reason: "召回",
    }, db)).rejects.toThrow(/隔离作业的目标必须是隔离库位/);
  });

  it("被隔离的量不能再出库：出库只吃未定位量（隔离才算「物理封存」）", async () => {
    const { db } = await createTestDb();
    const s = await seed(db);
    await quarantineOrReleaseBatch(s.warehouseUser, {
      idempotencyKey: "quarantine-block-out-1",
      intent: "quarantine",
      warehouseId: s.wh.id,
      skuId: s.sku.id,
      batchId: s.batch.id,
      qty: "90",
      reason: "整批召回",
    }, db);
    await expect(post(db, {
      sourceDocType: "sales_out",
      sourceDocId: 5,
      action: "post",
      lines: [{ sourceLineId: 1, skuId: s.sku.id, warehouseId: s.wh.id, batchId: s.batch.id, qtyDelta: "-20" }],
    })).rejects.toThrow(/未定位库存不足|LOCATED_STOCK|可出库/);
  });
});
