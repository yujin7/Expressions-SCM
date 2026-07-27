import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  auditLogs,
  batches,
  binBalances,
  binMovements,
  bins,
  skus,
  spus,
  stockBalances,
  users,
  warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { post } from "@/server/posting";
import {
  listBinInventory,
  postBinMovement,
} from "@/server/modules/inventory/bin-operations";
import { createTestDb, type TestDb } from "../helpers/db";

async function expectAppendOnlyRejection(query: PromiseLike<unknown>) {
  try {
    await query;
    throw new Error("expected append-only rejection");
  } catch (error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    expect(`${(error as Error).message}\n${cause instanceof Error ? cause.message : ""}`).toMatch(/append-only/i);
  }
}

describe("库位定位子账", () => {
  let db: TestDb;
  let actor: SessionUser;
  let warehouseId: number;
  let skuId: number;
  let batchId: number;
  let normalBinId: number;
  let stagingBinId: number;
  let quarantineBinId: number;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({ name: "仓管", roles: ["warehouse"] }).returning();
    actor = { id: user.id, name: user.name, roles: ["warehouse"], isApprover: false };
    const [spu] = await db.insert(spus).values({ code: "BIN-SPU", nameCn: "库位测试" }).returning();
    const [sku] = await db.insert(skus).values({
      spuId: spu.id,
      code: "BIN-SKU",
      name: "库位测试 SKU",
      skuType: "finished",
      baseUom: "件",
    }).returning();
    skuId = sku.id;
    const [warehouse] = await db.insert(warehouses).values({
      code: "BIN-WH",
      name: "库位测试仓",
      kind: "finished",
      accountingMode: "realtime",
    }).returning();
    warehouseId = warehouse.id;
    const createdBins = await db.insert(bins).values([
      { warehouseId, code: "N-01", name: "普通位", kind: "normal" },
      { warehouseId, code: "S-01", name: "暂存位", kind: "staging" },
      { warehouseId, code: "Q-01", name: "隔离位", kind: "quarantine" },
    ]).returning();
    normalBinId = createdBins[0].id;
    stagingBinId = createdBins[1].id;
    quarantineBinId = createdBins[2].id;
    const [batch] = await db.insert(batches).values({
      skuId,
      batchNo: "LOT-001",
      expiryDate: "2027-12-31",
    }).returning();
    batchId = batch.id;
    await db.insert(stockBalances).values({ warehouseId, skuId, batchId, qty: "10" });
  });

  const movement = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: "bin-move-key-0001",
    warehouseId,
    skuId,
    batchId,
    fromBinId: null,
    toBinId: normalBinId,
    qty: "6",
    operation: "locate",
    reason: "收货上架",
    ...overrides,
  });

  it("定位不改仓库总账，并精确呈现已定位与未定位差额", async () => {
    const result = await postBinMovement(actor, movement(), db);
    expect(result.idempotent).toBe(false);

    const [warehouseBalance] = await db.select().from(stockBalances);
    expect(warehouseBalance.qty).toBe("10.0000");
    const inventory = await listBinInventory({ warehouseId }, db);
    expect(inventory.totals).toMatchObject({
      located: "6.0000",
      unlocated: "4.0000",
      normal: "6.0000",
      quarantine: "0.0000",
    });
    expect(inventory.integrityIssues).toEqual([]);
    expect(inventory.rows.map((row) => [row.locationState, row.qty])).toEqual([
      ["located", "6.0000"],
      ["unlocated", "4.0000"],
    ]);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entity, "bin_movement"));
    expect(audit).toMatchObject({ entityId: result.id, action: "locate", userId: actor.id });
  });

  it("相同幂等请求只执行一次，但相同键的不同载荷被拒绝", async () => {
    const first = await postBinMovement(actor, movement(), db);
    // 幂等重放优先于当前主数据状态；原请求成功后即使库位随后停用，重试也不能再执行或报假失败。
    await db.update(bins).set({ active: false }).where(eq(bins.id, normalBinId));
    const retry = await postBinMovement(actor, movement(), db);
    expect(retry).toEqual({ id: first.id, idempotent: true });
    expect(await db.select().from(binMovements)).toHaveLength(1);
    expect((await db.select().from(binBalances))[0].qty).toBe("6.0000");

    await expect(postBinMovement(actor, movement({ qty: "5" }), db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("幂等键"),
    });
  });

  it("阻止超分仓库总账及来源库位透支", async () => {
    await expect(postBinMovement(actor, movement({ qty: "11" }), db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("未定位库存不足"),
    });
    expect(await db.select().from(binMovements)).toHaveLength(0);

    await postBinMovement(actor, movement(), db);
    await expect(postBinMovement(actor, movement({
      idempotencyKey: "bin-move-key-0002",
      fromBinId: normalBinId,
      toBinId: stagingBinId,
      operation: "move",
      qty: "7",
    }), db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("库存不足"),
    });
  });

  it("隔离与放行必须走显式语义，移动后仍保持总量不变", async () => {
    await postBinMovement(actor, movement(), db);
    await expect(postBinMovement(actor, movement({
      idempotencyKey: "bin-move-key-0002",
      fromBinId: normalBinId,
      toBinId: quarantineBinId,
      operation: "move",
    }), db)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("隔离作业") });

    await postBinMovement(actor, movement({
      idempotencyKey: "bin-move-key-0003",
      fromBinId: normalBinId,
      toBinId: quarantineBinId,
      operation: "quarantine",
      qty: "2",
      reason: "抽检异常",
    }), db);
    let inventory = await listBinInventory({ warehouseId }, db);
    expect(inventory.totals).toMatchObject({ normal: "4.0000", quarantine: "2.0000", located: "6.0000" });

    await expect(postBinMovement(actor, movement({
      idempotencyKey: "bin-move-key-0004",
      fromBinId: quarantineBinId,
      toBinId: stagingBinId,
      operation: "move",
      qty: "1",
    }), db)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("放行作业") });

    await postBinMovement(actor, movement({
      idempotencyKey: "bin-move-key-0005",
      fromBinId: quarantineBinId,
      toBinId: stagingBinId,
      operation: "release",
      qty: "1",
      reason: "质检放行",
    }), db);
    inventory = await listBinInventory({ warehouseId }, db);
    expect(inventory.totals).toMatchObject({
      located: "6.0000",
      normal: "4.0000",
      quarantine: "1.0000",
      staging: "1.0000",
    });
  });

  it("所有出库过账只能消耗未定位量，已定位与隔离库存不能被旁路发出", async () => {
    await postBinMovement(actor, movement(), db); // 总账10：已定位6、未定位4
    await postBinMovement(actor, movement({
      idempotencyKey: "bin-protect-quarantine",
      fromBinId: normalBinId,
      toBinId: quarantineBinId,
      operation: "quarantine",
      qty: "2",
      reason: "待检隔离",
    }), db);

    await expect(post(db, {
      sourceDocType: "sales_out",
      sourceDocId: 8001,
      action: "post",
      lines: [{ sourceLineId: 1, skuId, warehouseId, batchId, qtyDelta: "-5" }],
    })).rejects.toMatchObject({
      name: "PostingError",
      code: "LOCATED_STOCK",
      message: expect.stringContaining("请先在库位作业中取消定位或放行"),
    });
    expect((await db.select().from(stockBalances))[0].qty).toBe("10.0000");

    // 未定位 4 可直接出；剩余总账 6 与已定位 6 严格相等。
    expect((await post(db, {
      sourceDocType: "sales_out",
      sourceDocId: 8002,
      action: "post",
      lines: [{ sourceLineId: 1, skuId, warehouseId, batchId, qtyDelta: "-4" }],
    })).posted).toBe(true);
    expect((await db.select().from(stockBalances))[0].qty).toBe("6.0000");

    // 明确取消一个普通库位数量后，才新增一个可出量；隔离量仍受保护。
    await postBinMovement(actor, movement({
      idempotencyKey: "bin-protect-unlocate",
      fromBinId: normalBinId,
      toBinId: null,
      operation: "unlocate",
      qty: "1",
      reason: "拣货下架",
    }), db);
    expect((await post(db, {
      sourceDocType: "sales_out",
      sourceDocId: 8003,
      action: "post",
      lines: [{ sourceLineId: 1, skuId, warehouseId, batchId, qtyDelta: "-1" }],
    })).posted).toBe(true);
    const inventory = await listBinInventory({ warehouseId }, db);
    expect(inventory.totals).toMatchObject({
      located: "5.0000",
      unlocated: "0.0000",
      quarantine: "2.0000",
    });
  });

  it("显式报告库位总和超过仓库总账的既有数据异常", async () => {
    await db.insert(binBalances).values({ binId: normalBinId, skuId, batchId, qty: "12" });
    const inventory = await listBinInventory({ warehouseId }, db);
    expect(inventory.integrityIssues).toEqual([
      expect.objectContaining({
        skuCode: "BIN-SKU",
        batchNo: "LOT-001",
        warehouseQty: "10.0000",
        locatedQty: "12.0000",
      }),
    ]);
    expect(inventory.totals.unlocated).toBe("0.0000");
  });

  it("快照仓和无权限角色不能执行库位作业", async () => {
    const [snapshot] = await db.insert(warehouses).values({
      code: "BIN-SNAP",
      name: "外部快照仓",
      kind: "snapshot",
      accountingMode: "snapshot",
    }).returning();
    await expect(postBinMovement({ ...actor, roles: ["pmc"] }, movement(), db)).rejects.toMatchObject({ status: 403 });
    await expect(postBinMovement(actor, movement({ warehouseId: snapshot.id }), db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("快照仓"),
    });
  });

  it("库位移动事实由数据库阻止改写、删除和截断", async () => {
    const result = await postBinMovement(actor, movement(), db);
    const [persisted] = await db.select().from(binMovements).where(eq(binMovements.id, result.id));
    expect(persisted.qty).toBe("6.0000");
    await expectAppendOnlyRejection(
      db.update(binMovements).set({ qty: "9" }).where(eq(binMovements.id, result.id)),
    );
    await expectAppendOnlyRejection(
      db.delete(binMovements).where(eq(binMovements.id, result.id)),
    );
    await expectAppendOnlyRejection(db.execute(sql`TRUNCATE TABLE bin_movements`));
  });
});
