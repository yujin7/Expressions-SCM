/**
 * RED TEAM — 库存单据模块：外层事务回滚、重复 SKU 行、调拨红字。
 * 约定：断言【正确】行为；用例失败 = 漏洞证实。
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { approvalConfigs, approvals, skus, spus, stockDocs, stockLedger, users, warehouses } from "@/db/schema";
import { dCmp } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { getBalance } from "@/server/posting/post";
import {
  approveStockDoc, createStockDoc, reverseStockDoc, submitStockDoc,
} from "@/server/modules/inventory/stock-doc";
import { createTestDb, type TestDb } from "../helpers/db";

describe("redteam/stock-doc", () => {
  let db: TestDb;
  let creator: SessionUser;
  let approver: SessionUser;
  let wh1: number;
  let wh2: number;
  let spuId: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    creator = await mkUser("SD制单", ["warehouse"], true);
    approver = await mkUser("SD审批", ["warehouse"], true);
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "warehouse" }, // 机制测试；生产 seed 为 finance（见专项测试）
      { docType: "count", approverRole: "warehouse" },
    ]);
    const [spu] = await db.insert(spus).values({ code: "P70001", nameCn: "SD产品" }).returning();
    spuId = spu.id;
    const [w1] = await db.insert(warehouses).values({ code: "WH-SD-1", name: "SD一仓", kind: "raw" }).returning();
    const [w2] = await db.insert(warehouses).values({ code: "WH-SD-2", name: "SD二仓", kind: "raw" }).returning();
    wh1 = w1.id;
    wh2 = w2.id;
  });

  let seq = 0;
  async function makeSku(): Promise<number> {
    seq += 1;
    const [s] = await db.insert(skus).values({
      code: `SD${String(seq).padStart(5, "0")}`, name: `SD物料${seq}`, spuId, baseUom: "个", skuType: "raw",
    }).returning();
    return s.id;
  }

  async function complete(input: unknown): Promise<number> {
    const doc = await createStockDoc(creator, input, db);
    const pending = await submitStockDoc(creator, doc.id, doc.version, db);
    const r = await approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");
    return doc.id;
  }

  it("外层事务回滚吞掉内层审批 savepoint：负库存审批失败后 approvals 表必须为空（对照组）", async () => {
    const sku = await makeSku();
    const doc = await createStockDoc(creator, { subtype: "issue_out", warehouseId: wh1, lines: [{ skuId: sku, qty: "5" }] }, db);
    const pending = await submitStockDoc(creator, doc.id, doc.version, db);
    await expect(
      approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ status: 409 });
    const rows = await db.select().from(approvals)
      .where(and(eq(approvals.docType, "stock_doc"), eq(approvals.docId, doc.id)));
    expect(rows).toHaveLength(0);
    const [d] = await db.select().from(stockDocs).where(eq(stockDocs.id, doc.id));
    expect(d.status).toBe("pending");
    expect(dCmp(await getBalance(db, sku, wh1), "0")).toBe(0);
  });

  it("同一 SKU 重复行（期初 5+3、领料 2+2）：余额算术正确、流水逐行落账", async () => {
    const sku = await makeSku();
    const openId = await complete({
      subtype: "opening", warehouseId: wh1,
      lines: [{ skuId: sku, qty: "5" }, { skuId: sku, qty: "3" }],
    });
    expect(dCmp(await getBalance(db, sku, wh1), "8")).toBe(0);
    const openLedger = await db.select().from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "opening"), eq(stockLedger.sourceDocId, openId)));
    expect(openLedger).toHaveLength(2);

    await complete({
      subtype: "issue_out", warehouseId: wh1,
      lines: [{ skuId: sku, qty: "2" }, { skuId: sku, qty: "2" }],
    });
    expect(dCmp(await getBalance(db, sku, wh1), "4")).toBe(0);
  });

  it("调拨红字冲销：两腿全部复原（wh1 回满、wh2 归零）", async () => {
    const sku = await makeSku();
    await complete({ subtype: "opening", warehouseId: wh1, lines: [{ skuId: sku, qty: "10" }] });
    const trId = await complete({
      subtype: "transfer", warehouseId: wh1, toWarehouseId: wh2, lines: [{ skuId: sku, qty: "4" }],
    });
    expect(dCmp(await getBalance(db, sku, wh1), "6")).toBe(0);
    expect(dCmp(await getBalance(db, sku, wh2), "4")).toBe(0);

    const rev = await reverseStockDoc(creator, trId, { reason: "调拨错误" }, db);
    const pending = await submitStockDoc(creator, rev.id, rev.version, db);
    const r = await approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db);
    expect(r.status).toBe("completed");

    expect(dCmp(await getBalance(db, sku, wh1), "10")).toBe(0);
    expect(dCmp(await getBalance(db, sku, wh2), "0")).toBe(0);

    const revLedger = await db.select().from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "stock_doc"), eq(stockLedger.sourceDocId, rev.id)));
    expect(revLedger).toHaveLength(2); // 两腿都有冲销流水
  });

  it("调拨重复 SKU 两行 → sourceLineId=±id 不碰撞，4 条流水", async () => {
    const sku = await makeSku();
    await complete({ subtype: "opening", warehouseId: wh1, lines: [{ skuId: sku, qty: "10" }] });
    const trId = await complete({
      subtype: "transfer", warehouseId: wh1, toWarehouseId: wh2,
      lines: [{ skuId: sku, qty: "1" }, { skuId: sku, qty: "2" }],
    });
    const rows = await db.select().from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "transfer"), eq(stockLedger.sourceDocId, trId)));
    expect(rows).toHaveLength(4);
    expect(dCmp(await getBalance(db, sku, wh1), "7")).toBe(0);
    expect(dCmp(await getBalance(db, sku, wh2), "3")).toBe(0);
  });

  it("[BUG?] 并发双审批同一单：一方成功、一方幂等/版本冲突，绝不双重过账", async () => {
    const sku = await makeSku();
    const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: wh1, lines: [{ skuId: sku, qty: "6" }] }, db);
    const pending = await submitStockDoc(creator, doc.id, doc.version, db);
    const results = await Promise.allSettled([
      approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db),
      approveStockDoc(approver, pending.id, { action: "approve", version: pending.version }, db),
    ]);
    // 正确行为：余额只 +6 一次（幂等或版本冲突挡住第二次）
    expect(dCmp(await getBalance(db, sku, wh1), "6")).toBe(0);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const ledger = await db.select().from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "opening"), eq(stockLedger.sourceDocId, doc.id)));
    expect(ledger).toHaveLength(1);
  });

  it("红字单被驳回（→draft）后原单可再次发起冲销吗？——非 void 红字存在即拒绝（特征化）", async () => {
    const sku = await makeSku();
    const origId = await complete({ subtype: "opening", warehouseId: wh1, lines: [{ skuId: sku, qty: "5" }] });
    const rev1 = await reverseStockDoc(creator, origId, { reason: "first" }, db);
    const p = await submitStockDoc(creator, rev1.id, rev1.version, db);
    const r = await approveStockDoc(approver, p.id, { action: "reject", version: p.version }, db);
    expect(r.status).toBe("draft");
    // 红字单回草稿（非 void）→ 第二张红字被 409 挡住；死草稿红字会永久锁死原单的纠错通道（无 void API 时）
    await expect(reverseStockDoc(creator, origId, { reason: "second" }, db)).rejects.toMatchObject({ status: 409 });
  });
});
