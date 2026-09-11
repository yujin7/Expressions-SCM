/**
 * D60 调拨费用写路径（inventory/transfer-fees.ts）：只允许已审批/完成调拨单；红字作废一次；
 * writeAudit 同事务；录费返回基线提醒（不阻断）。
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { approvalConfigs, auditLogs, skus, spus, transferFees, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { approveStockDoc, createStockDoc, submitStockDoc } from "@/server/modules/inventory/stock-doc";
import { addTransferFee, addTransferFeeSchema, listTransferFees, reverseTransferFee, transferFeeNetByDoc } from "@/server/modules/inventory/transfer-fees";
import { createTestDb, type TestDb } from "../helpers/db";

describe("transfer-fees：登记 / 红字作废 / 列表", () => {
  let db: TestDb;
  let creator: SessionUser;
  let approver: SessionUser;
  let finance: SessionUser;
  let whA: number;
  let whB: number;
  let skuId: number;
  let completedDocId = 0;
  let draftDocId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    creator = await mk("费用制单", ["warehouse"], false);
    approver = await mk("费用审批", ["warehouse"], true);
    finance = await mk("费用财务", ["finance"], false);
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "warehouse" },
    ]);
    const [a] = await db.insert(warehouses).values({ code: "TF-A", name: "工厂仓", kind: "finished" }).returning();
    const [b] = await db.insert(warehouses).values({ code: "TF-B", name: "发货仓", kind: "finished" }).returning();
    whA = a.id;
    whB = b.id;
    const [spu] = await db.insert(spus).values({ code: "PTF01", nameCn: "费用测试品" }).returning();
    const [s] = await db.insert(skus).values({ code: "TF001", name: "费用SKU", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    skuId = s.id;
    const opening = await createStockDoc(creator, { subtype: "opening", warehouseId: whA, lines: [{ skuId, qty: "1000" }] }, db);
    const so = await submitStockDoc(creator, opening.id, opening.version, db);
    await approveStockDoc(approver, opening.id, { action: "approve", version: so.version }, db);

    const tr = await createStockDoc(
      creator,
      { subtype: "transfer", transferType: "factory_to_warehouse", warehouseId: whA, toWarehouseId: whB, lines: [{ skuId, qty: "100" }] },
      db,
    );
    const st = await submitStockDoc(creator, tr.id, tr.version, db);
    await approveStockDoc(approver, tr.id, { action: "approve", version: st.version }, db);
    completedDocId = tr.id;
    const draft = await createStockDoc(
      creator,
      { subtype: "transfer", transferType: "factory_to_warehouse", warehouseId: whA, toWarehouseId: whB, lines: [{ skuId, qty: "50" }] },
      db,
    );
    draftDocId = draft.id;
  });

  it("草稿调拨单不可登记费用（409）；非调拨单 400", async () => {
    await expect(
      addTransferFee(finance, { stockDocId: draftDocId, feeType: "freight", amount: "10", bizDate: "2026-09-01" }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 409 });
    await expect(
      addTransferFee(finance, { stockDocId: 999999, feeType: "freight", amount: "10", bizDate: "2026-09-01" }, db),
    ).rejects.toMatchObject({ name: "ApiError", status: 404 });
    await expect(
      addTransferFee(finance, { stockDocId: completedDocId, feeType: "tip", amount: "10", bizDate: "2026-09-01" }, db),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      addTransferFee(finance, { stockDocId: completedDocId, feeType: "freight", amount: "-1", bizDate: "2026-09-01" }, db),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("invalid date filters fail before querying, including impossible calendar days and reversed bounds", async () => {
    for (const value of ["bad", "2026-13-45", "2026-02-29", "2026-04-31", "0000-01-01", " "]) {
      for (const field of ["dateFrom", "dateTo"]) await expect(listTransferFees({ [field]: value }, db)).rejects.toMatchObject({ status: 400 });
    }
    await expect(listTransferFees({ dateFrom: "2026-09-02", dateTo: "2026-09-01" }, db)).rejects.toMatchObject({ status: 400 });
    expect((await listTransferFees({ dateFrom: "2024-02-29", dateTo: "2024-02-29" }, db)).total).toBe(0);
  });

  it("bad amounts are validation errors, not decimal parser exceptions; input dates are real dates", () => {
    const base = { stockDocId: completedDocId, feeType: "freight", amount: "1", bizDate: "2026-09-01" };
    for (const amount of ["abc", "NaN", "Infinity", "1e4", "", "--1"]) {
      expect(addTransferFeeSchema.safeParse({ ...base, amount }).success).toBe(false);
    }
    expect(addTransferFeeSchema.safeParse({ ...base, bizDate: "2026-02-29" }).success).toBe(false);
    expect(addTransferFeeSchema.safeParse({ ...base, bizDate: "2024-02-29" }).success).toBe(true);
  });

  it("已完成调拨单登记费用：金额 scale 2、审计同事务、首单无基线 → 提醒 ok/样本不足", async () => {
    const { fee, warning } = await addTransferFee(
      finance,
      { stockDocId: completedDocId, feeType: "freight", amount: "1234.5", carrier: "顺丰", bizDate: "2026-09-01", note: "首单" },
      db,
    );
    expect(fee.amount).toBe("1234.50");
    expect(fee.reversalOfId).toBeNull();
    expect(warning).not.toBeNull();
    expect(warning!.level).toBe("ok");
    expect(warning!.insufficient).toBe(true);
    expect(warning!.docUnitFee).toBe("12.3450");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "transfer_fee"), eq(auditLogs.entityId, fee.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("create");

    const net = await transferFeeNetByDoc([completedDocId], db);
    expect(net.get(completedDocId)).toEqual({ amount: "1234.50", count: 1 });
  });

  it("红字作废：负额新行、原行保留、只能冲一次、红字不可再冲", async () => {
    const [orig] = await db.select().from(transferFees).where(and(eq(transferFees.stockDocId, completedDocId), eq(transferFees.feeType, "freight")));
    const rev = await reverseTransferFee(finance, { reversalOfId: orig.id, reason: "重复登记" }, db);
    expect(rev.amount).toBe("-1234.50");
    expect(rev.reversalOfId).toBe(orig.id);
    await expect(reverseTransferFee(finance, { reversalOfId: orig.id, reason: "再冲" }, db)).rejects.toMatchObject({ status: 409 });
    await expect(reverseTransferFee(finance, { reversalOfId: rev.id, reason: "冲红字" }, db)).rejects.toMatchObject({ status: 400 });
    const net = await transferFeeNetByDoc([completedDocId], db);
    expect(net.get(completedDocId)).toEqual({ amount: "0.00", count: 2 });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "transfer_fee"), eq(auditLogs.action, "reverse")));
    expect(audits).toHaveLength(1);
  });

  it("列表：全部 / 仅有效 视图；按单据、费用类型、线路筛选", async () => {
    await addTransferFee(finance, { stockDocId: completedDocId, feeType: "handling", amount: "20", bizDate: "2026-09-02" }, db);
    const all = await listTransferFees({ stockDocId: completedDocId }, db);
    expect(all.total).toBe(3);
    expect(all.rows[0]).toMatchObject({ docNo: expect.stringMatching(/^DB-/), fromWarehouse: "工厂仓", toWarehouse: "发货仓", transferType: "factory_to_warehouse" });
    const active = await listTransferFees({ stockDocId: completedDocId, view: "active" }, db);
    expect(active.total).toBe(1);
    expect(active.rows[0]).toMatchObject({ feeType: "handling", amount: "20.00", reversed: false, reversalOfId: null });
    const byType = await listTransferFees({ feeType: "freight", view: "all" }, db);
    expect(byType.rows.every((r) => r.feeType === "freight")).toBe(true);
    expect(byType.rows.some((r) => r.reversed)).toBe(true);
    const byLane = await listTransferFees({ fromWarehouseId: whA, toWarehouseId: whB, transferType: "factory_to_warehouse" }, db);
    expect(byLane.total).toBe(3);
    const none = await listTransferFees({ fromWarehouseId: whB }, db);
    expect(none.total).toBe(0);
  });
  it("create and reversal reject a revoked role or disabled account even through direct service calls", async () => {
    const [u] = await db.insert(users).values({ name: "fee stale session", roles: ["finance"] }).returning();
    const stale = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
    const input = { stockDocId: completedDocId, feeType: "freight", amount: "2", bizDate: "2026-09-11" };
    const fee = await addTransferFee(stale, input, db);
    for (const patch of [{ roles: ["ops"] }, { roles: ["finance"], active: false }, { active: true, sessionVersion: u.sessionVersion + 1 }]) {
      await db.update(users).set(patch).where(eq(users.id, u.id));
      const before = await db.select().from(transferFees);
      await expect(addTransferFee(stale, input, db)).rejects.toMatchObject({ status: "sessionVersion" in patch ? 401 : 403 });
      await expect(reverseTransferFee(stale, { reversalOfId: fee.fee.id, reason: "重复" }, db)).rejects.toMatchObject({ status: "sessionVersion" in patch ? 401 : 403 });
      expect(await db.select().from(transferFees)).toEqual(before);
    }
  });
});
