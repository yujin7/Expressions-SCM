import { beforeAll, describe, expect, it } from "vitest";
import { approvalConfigs, skus, spus, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { approveStockDoc, createStockDoc, submitStockDoc } from "@/server/modules/inventory/stock-doc";
import { getJiediaoReport } from "@/server/modules/report/jiediao";
import { createTestDb, type TestDb } from "../helpers/db";

describe("R16 借调对账：reason='借调' 的完成态调拨进入月度矩阵", () => {
  let db: TestDb;
  let creator: SessionUser;
  let approver: SessionUser;
  let whA: number;
  let whB: number;
  let skuId: number;
  const month = new Date().toISOString().slice(0, 7); // 测试内当月过账

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles: ["warehouse"], isApprover }).returning();
      return { id: u.id, name: u.name, roles: ["warehouse"], isApprover };
    };
    creator = await mk("借调制单", false);
    approver = await mk("借调审批", true);
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "warehouse" }, // 机制测试口径（生产 seed=finance）
    ]);
    const [a] = await db.insert(warehouses).values({ code: "JD-A", name: "电商部仓", kind: "finished" }).returning();
    const [b] = await db.insert(warehouses).values({ code: "JD-B", name: "商务部仓", kind: "finished" }).returning();
    whA = a.id;
    whB = b.id;
    const [spu] = await db.insert(spus).values({ code: "PJD01", nameCn: "借调测试品" }).returning();
    const [s] = await db
      .insert(skus)
      .values({ code: "JD001", name: "借调SKU", spuId: spu.id, baseUom: "件", skuType: "finished" })
      .returning();
    skuId = s.id;
    // 期初铺底：A 仓 100
    const opening = await createStockDoc(
      creator,
      { subtype: "opening", warehouseId: whA, lines: [{ skuId, qty: "100" }] },
      db,
    );
    const so = await submitStockDoc(creator, opening.id, opening.version, db);
    await approveStockDoc(approver, opening.id, { action: "approve", version: so.version }, db);
  });

  it("借调调拨完成后进入报表；普通调拨不进入", async () => {
    // 借调 30：A → B
    const jd = await createStockDoc(
      creator,
      { subtype: "transfer", warehouseId: whA, toWarehouseId: whB, reason: "借调", remark: "直播活动借货", lines: [{ skuId, qty: "30" }] },
      db,
    );
    const s1 = await submitStockDoc(creator, jd.id, jd.version, db);
    await approveStockDoc(approver, jd.id, { action: "approve", version: s1.version }, db);
    // 普通调拨 10：A → B（无 reason）
    const normal = await createStockDoc(
      creator,
      { subtype: "transfer", warehouseId: whA, toWarehouseId: whB, lines: [{ skuId, qty: "10" }] },
      db,
    );
    const s2 = await submitStockDoc(creator, normal.id, normal.version, db);
    await approveStockDoc(approver, normal.id, { action: "approve", version: s2.version }, db);

    const rep = await getJiediaoReport(month, db);
    expect(rep.lines).toHaveLength(1);
    expect(rep.lines[0]).toMatchObject({ skuCode: "JD001", qty: "30.0000", fromWarehouse: "电商部仓", toWarehouse: "商务部仓" });
    expect(rep.matrix).toEqual([{ fromWarehouse: "电商部仓", toWarehouse: "商务部仓", docCount: 1, totalQty: 30 }]);
    const netA = rep.netByWarehouse.find((n) => n.warehouse === "电商部仓")!;
    const netB = rep.netByWarehouse.find((n) => n.warehouse === "商务部仓")!;
    expect(netA).toMatchObject({ lentOut: 30, borrowedIn: 0, net: -30 });
    expect(netB).toMatchObject({ borrowedIn: 30, lentOut: 0, net: 30 });
  });

  it("非调拨单填 reason 被拒（R16 语义只挂调拨）", async () => {
    await expect(
      createStockDoc(creator, { subtype: "sales_out", warehouseId: whA, reason: "借调", lines: [{ skuId, qty: "1" }] }, db),
    ).rejects.toThrow(/仅调拨/);
  });

  it("月份格式校验", async () => {
    await expect(getJiediaoReport("2026/07", db)).rejects.toThrow(/YYYY-MM/);
  });
});
