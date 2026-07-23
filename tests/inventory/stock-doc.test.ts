import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { approvalConfigs, approvals, skus, spus, stockDocs, stockLedger, users, warehouses } from "@/db/schema";
import { dCmp } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { getBalance } from "@/server/posting/post";
import { listBalances, listBalancesBySpu, listLedger } from "@/server/modules/inventory/queries";
import {
  approveStockDoc, createStockDoc, getStockDoc, listStockDocs, reverseStockDoc, submitStockDoc,
} from "@/server/modules/inventory/stock-doc";
import { createTestDb, type TestDb } from "../helpers/db";

describe("库存单据 W2：期初/领料出/销售出/调拨 + 红字冲销", () => {
  let db: TestDb;
  let creator: SessionUser;
  let approver: SessionUser;
  let admin: SessionUser;
  let nonApprover: SessionUser;
  let wh1: number; // 实时原料仓
  let wh2: number; // 实时原料仓
  let whSnap: number; // 快照仓（1.1 启用）
  let spuId: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    // 制单人本身也是审批人——用于验证职责分离（SELF_APPROVAL 优先于 NOT_APPROVER 之外的场景）
    creator = await mkUser("仓库制单员", ["warehouse"], true);
    approver = await mkUser("仓库审批人", ["warehouse"], true);
    admin = await mkUser("管理员", ["admin"], false);
    nonApprover = await mkUser("仓库普通员", ["warehouse"], false);
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "warehouse" }, // 机制测试；生产 seed 为 finance（见专项测试）
      { docType: "count", approverRole: "warehouse" },
    ]);

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    spuId = spu.id;
    const [w1] = await db.insert(warehouses).values({ code: "WH-RAW-1", name: "原料一仓", kind: "raw" }).returning();
    const [w2] = await db.insert(warehouses).values({ code: "WH-RAW-2", name: "原料二仓", kind: "raw" }).returning();
    const [w3] = await db
      .insert(warehouses)
      .values({ code: "WH-SNAP", name: "保税快照仓", kind: "snapshot", accountingMode: "snapshot" })
      .returning();
    wh1 = w1.id;
    wh2 = w2.id;
    whSnap = w3.id;
  });

  let skuSeq = 0;
  async function makeSku(): Promise<number> {
    skuSeq += 1;
    const [s] = await db
      .insert(skus)
      .values({ code: `RA${String(skuSeq).padStart(5, "0")}`, name: `测试物料${skuSeq}`, spuId, baseUom: "个", skuType: "raw" })
      .returning();
    return s.id;
  }

  /** 创建→提交，返回待审批单据（版本为提交后版本） */
  async function makePending(input: unknown) {
    const doc = await createStockDoc(creator, input, db);
    expect(doc.status).toBe("draft");
    return submitStockDoc(creator, doc.id, doc.version, db);
  }

  /** 创建→提交→审批通过 */
  async function complete(input: unknown) {
    const pending = await makePending(input);
    const r = await approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db);
    expect(r).toMatchObject({ status: "completed", idempotent: false });
    return pending.id;
  }

  const openingInput = (skuId: number, whId: number, qty: string) => ({
    subtype: "opening", warehouseId: whId, lines: [{ skuId, qty }],
  });

  it("1) 期初：创建→提交→审批 → completed，余额+，流水存在", async () => {
    const sku = await makeSku();
    const docId = await complete(openingInput(sku, wh1, "10"));

    const detail = await getStockDoc(docId, db);
    expect(detail.status).toBe("completed");
    expect(detail.docNo.startsWith("RK-")).toBe(true);
    expect(detail.warehouseId).toBe(wh1);
    expect(detail.warehouseName).toBe("原料一仓");
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]).toMatchObject({ approverName: "仓库审批人", action: "approve" });
    expect(detail.lines[0]).toMatchObject({ skuId: sku, baseUom: "个" });

    expect(dCmp(await getBalance(db, sku, wh1), "10")).toBe(0);

    const ledger = await listLedger({ skuId: sku, warehouseId: wh1, page: 1, pageSize: 10 }, db);
    expect(ledger.total).toBe(1);
    expect(ledger.rows[0]).toMatchObject({
      warehouseName: "原料一仓",
      sourceDocType: "opening",
      sourceDocId: docId,
      action: "post",
    });

    const bal = await listBalances({ warehouseId: wh1, page: 1, pageSize: 50 }, db);
    const row = (bal.rows as Record<string, unknown>[]).find((r) => r.skuId === sku);
    expect(row).toMatchObject({
      warehouseId: wh1, warehouseName: "原料一仓", warehouseKind: "raw",
      spuCode: "P00001", spuNameCn: "测试产品", baseUom: "个", batchId: null,
    });

    const spuAgg = await listBalancesBySpu({ q: "P00001", page: 1, pageSize: 10 }, db);
    expect(spuAgg.total).toBe(1);
    expect((spuAgg.rows[0] as Record<string, unknown>).skuCount).toBeGreaterThanOrEqual(1);
  });

  it("2) 领料出超库存：审批 409，单据仍 pending，无审批记录，余额不变（原子回滚）", async () => {
    const sku = await makeSku();
    await complete(openingInput(sku, wh1, "3"));

    const pending = await makePending({ subtype: "issue_out", warehouseId: wh1, lines: [{ skuId: sku, qty: "5" }] });
    await expect(
      approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 409, message: expect.stringContaining("库存不足") });

    const [doc] = await db.select().from(stockDocs).where(eq(stockDocs.id, pending.id));
    expect(doc.status).toBe("pending");
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.docType, "stock_doc"), eq(approvals.docId, pending.id)));
    expect(rows).toHaveLength(0); // 审批记录随事务整体回滚
    expect(dCmp(await getBalance(db, sku, wh1), "3")).toBe(0);
  });

  it("3) 调拨：两实时仓间转移；调拨转入快照仓创建即拒绝", async () => {
    const sku = await makeSku();
    await complete(openingInput(sku, wh1, "10"));

    const transferId = await complete({
      subtype: "transfer", warehouseId: wh1, toWarehouseId: wh2, lines: [{ skuId: sku, qty: "4" }],
    });
    expect(dCmp(await getBalance(db, sku, wh1), "6")).toBe(0);
    expect(dCmp(await getBalance(db, sku, wh2), "4")).toBe(0);

    const detail = await getStockDoc(transferId, db);
    expect(detail.docNo.startsWith("DB-")).toBe(true);
    expect(detail.toWarehouseId).toBe(wh2);
    expect(detail.toWarehouseName).toBe("原料二仓");

    await expect(
      createStockDoc(creator, { subtype: "transfer", warehouseId: wh1, toWarehouseId: whSnap, lines: [{ skuId: sku, qty: "1" }] }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 400, message: expect.stringContaining("快照仓 1.1 启用") });

    // 转出仓=快照仓亦拒绝
    await expect(
      createStockDoc(creator, { subtype: "opening", warehouseId: whSnap, lines: [{ skuId: sku, qty: "1" }] }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 400 });
  });

  it("4) 驳回 → 回草稿；可重新提交", async () => {
    const sku = await makeSku();
    const pending = await makePending(openingInput(sku, wh1, "2"));
    const r = await approveStockDoc(approver, pending.id, { action: "reject", comment: "数量存疑", version: pending.version }, db);
    expect(r.status).toBe("draft");

    const [doc] = await db.select().from(stockDocs).where(eq(stockDocs.id, pending.id));
    expect(doc.status).toBe("draft");
    // 驳回不过账
    expect(dCmp(await getBalance(db, sku, wh1), "0")).toBe(0);

    const resubmitted = await submitStockDoc(creator, doc.id, doc.version, db);
    expect(resubmitted.status).toBe("pending");
  });

  it("5) 红字冲销：期初完成后冲销 → 余额归零；同一原单二次冲销 → 409", async () => {
    const sku = await makeSku();
    const origId = await complete(openingInput(sku, wh1, "8"));
    expect(dCmp(await getBalance(db, sku, wh1), "8")).toBe(0);

    const rev = await reverseStockDoc(creator, origId, { reason: "期初录错" }, db);
    expect(rev.subtype).toBe("reversal");
    expect(rev.reversalOfId).toBe(origId);
    expect(rev.docNo.startsWith("RK-")).toBe(true); // 沿用原单前缀
    expect(rev.status).toBe("draft");
    expect(rev.remark).toBe("期初录错");

    const pending = await submitStockDoc(creator, rev.id, rev.version, db);
    const r = await approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
    expect(dCmp(await getBalance(db, sku, wh1), "0")).toBe(0);

    // 冲销流水：sourceDocType=stock_doc, action=reverse, 数量取负
    const revLedger = await db
      .select()
      .from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "stock_doc"), eq(stockLedger.sourceDocId, rev.id)));
    expect(revLedger).toHaveLength(1);
    expect(String(revLedger[0].action).startsWith("reverse:")).toBe(true);
    expect(dCmp(revLedger[0].qtyDelta, "-8")).toBe(0);

    // 二次冲销 → 409
    await expect(reverseStockDoc(creator, origId, { reason: "再冲一次" }, db)).rejects.toMatchObject({
      name: "ApiError", status: 409,
    });
    // 红字单自身不可再冲销
    await expect(reverseStockDoc(creator, rev.id, { reason: "套娃" }, db)).rejects.toMatchObject({
      name: "ApiError", status: 400,
    });
  });

  it("6) 职责分离：制单人自审 SELF_APPROVAL；非审批人 NOT_APPROVER；管理员可审", async () => {
    const sku = await makeSku();
    const pending = await makePending(openingInput(sku, wh1, "1"));
    await expect(
      approveStockDoc(creator, pending.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 403, message: expect.stringContaining("SELF_APPROVAL") });

    await expect(
      approveStockDoc(nonApprover, pending.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 403, message: expect.stringContaining("NOT_APPROVER") });

    // 管理员兜底可审批
    const r = await approveStockDoc(admin, pending.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
  });

  it("7) 乐观锁：过期版本审批 → VERSION_CONFLICT 409", async () => {
    const sku = await makeSku();
    const pending = await makePending(openingInput(sku, wh1, "1"));
    await expect(
      approveStockDoc(approver, pending.id, { action: "approve", version: pending.version + 99 }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 409, message: expect.stringContaining("VERSION_CONFLICT") });
    // 冲突后单据保持 pending，正确版本可继续审批
    const r = await approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
  });

  it("8) 销售出库扣减余额；单据列表/详情字段契约", async () => {
    const sku = await makeSku();
    await complete(openingInput(sku, wh1, "10"));
    const salesId = await complete({ subtype: "sales_out", warehouseId: wh1, lines: [{ skuId: sku, qty: "3" }] });
    expect(dCmp(await getBalance(db, sku, wh1), "7")).toBe(0);

    const detail = await getStockDoc(salesId, db);
    expect(detail.docNo.startsWith("CK-")).toBe(true);

    const list = await listStockDocs("", { subtype: "sales_out", page: 1, pageSize: 10 }, db);
    expect(list.total).toBeGreaterThanOrEqual(1);
    const row = (list.rows as Record<string, unknown>[]).find((r) => r.id === salesId);
    expect(row).toMatchObject({
      subtype: "sales_out", status: "completed", warehouseName: "原料一仓",
      toWarehouseName: null, lineCount: 1, createdByName: "仓库制单员",
    });
  });

  it("非手工子类型（purchase_in 等）创建 → 400 参数校验失败", async () => {
    const sku = await makeSku();
    await expect(
      createStockDoc(creator, { subtype: "purchase_in", warehouseId: wh1, lines: [{ skuId: sku, qty: "1" }] }, db),
    ).rejects.toMatchObject({ name: "ZodError" });
    // 调拨缺转入仓 / 转入=转出 → 校验失败
    await expect(
      createStockDoc(creator, { subtype: "transfer", warehouseId: wh1, lines: [{ skuId: sku, qty: "1" }] }, db),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      createStockDoc(creator, { subtype: "transfer", warehouseId: wh1, toWarehouseId: wh1, lines: [{ skuId: sku, qty: "1" }] }, db),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("提交权限：非制单人（非管理员）不可提交；管理员可提交", async () => {
    const sku = await makeSku();
    const doc = await createStockDoc(creator, openingInput(sku, wh1, "1"), db);
    await expect(submitStockDoc(approver, doc.id, doc.version, db)).rejects.toMatchObject({
      name: "ApiError", status: 403,
    });
    const submitted = await submitStockDoc(admin, doc.id, doc.version, db);
    expect(submitted.status).toBe("pending");
  });
});
