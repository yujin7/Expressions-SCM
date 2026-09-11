/**
 * C3 回归：**红字冲销一张盘盈亏调整单，余额必须回到调整前**。
 *
 * 事故形状：`inventory/count.ts` 把 `stock_doc_lines.qty` 写成**带符号**的（+盘盈 / −盘亏）
 * 并原样过账；可 `stock-doc.buildPostingEvent` 没有 `count_adjust` 分支，
 * 它掉进 `issue_out / sales_out` 的 else 分支被 `dNeg` 取负一次，`reverse()` 再取负一次——
 * 负负得正，红字**重放了一遍原始过账**。
 *
 * 算例（红队给的那一个）：账面 100，盘出 90 → CA 行 −10、流水 −10、余额 90；
 * 冲销后余额 **80**（正确应为 100）。`reverseStockDoc` 只挡 `subtype === "reversal"` 与非 completed，
 * 而 CA 单建出来就是 completed，`POST /api/inventory/stock-doc/{id}/reverse` 直达此处。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvalConfigs, pdDocs, skus, spus, stockBalances, stockDocLines, stockDocs, stockLedger, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  approveStockDoc, createStockDoc, reverseStockDoc, submitStockDoc,
} from "@/server/modules/inventory/stock-doc";
import {
  approveCountTask, createCountTask, getCountTask, submitCountTask, updateCounts,
} from "@/server/modules/inventory/count";
import { createTestDb, type TestDb } from "../helpers/db";

describe("C3 盘盈亏调整的红字冲销必须**抵消**而不是翻倍", () => {
  let db: TestDb;
  let creator: SessionUser;
  let whApprover: SessionUser;
  let finance: SessionUser;
  let whId = 0;
  let skuId = 0;

  const balanceOf = async (): Promise<string> => {
    const [row] = await db.select().from(stockBalances)
      .where(and(eq(stockBalances.skuId, skuId), eq(stockBalances.warehouseId, whId)));
    return row.qty;
  };

  /** 建一张盘点：账面 100 → 盘出 countedQty，审批后产生一张 completed 的 CA 调整单 */
  const runCount = async (countedQty: string): Promise<number> => {
    const task = await createCountTask(
      creator,
      { warehouseId: whId, mode: "partial", filters: { skuIds: [skuId] } },
      db,
    );
    const detail = await getCountTask(task.id, db);
    await updateCounts(creator, task.id, { version: task.version, lines: [{ lineId: detail.lines[0].id, countedQty }] }, db);
    const [afterUpd] = await db.select().from(pdDocs).where(eq(pdDocs.id, task.id));
    const pending = await submitCountTask(creator, task.id, afterUpd.version, db);
    const r = await approveCountTask(finance, task.id, { action: "approve", version: pending.version }, db);
    return r.adjustDocId!;
  };

  /** 冲销一张 CA 单：建红字 → 提交 → 审批（红字走 stock_doc 审批域，仓管） */
  const reverseAndApprove = async (caDocId: number): Promise<void> => {
    const red = await reverseStockDoc(creator, caDocId, { reason: "盘点复盘：本次调整作废" }, db);
    const pending = await submitStockDoc(creator, red.id, red.version, db);
    await approveStockDoc(whApprover, pending.id, { action: "approve", version: pending.version }, db);
  };

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: true }).returning();
      return { id: u.id, name: u.name, roles, isApprover: true };
    };
    creator = await mkUser("仓库制单员", ["warehouse"]);
    whApprover = await mkUser("仓库审批人", ["warehouse"]); // 职责分离：制单人不能审自己的红字
    finance = await mkUser("财务审批人", ["finance"]);
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "finance" },
      { docType: "count", approverRole: "finance" },
    ]);
    const [spu] = await db.insert(spus).values({ code: "C3SPU", nameCn: "冲销测试品" }).returning();
    const [wh] = await db.insert(warehouses).values({
      code: "WH-C3", name: "冲销测试仓", kind: "raw", accountingMode: "realtime", active: true,
    }).returning();
    whId = wh.id;
    const [sku] = await db.insert(skus).values({
      code: "C3SKU", name: "冲销测试物料", spuId: spu.id, baseUom: "个", skuType: "raw",
    }).returning();
    skuId = sku.id;
    const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: whId, lines: [{ skuId, qty: "100" }] }, db);
    const pending = await submitStockDoc(creator, doc.id, doc.version, db);
    await approveStockDoc(finance, pending.id, { action: "approve", version: pending.version }, db);
  });

  it("盘亏 100→90 冲销后余额回到 100（修复前是 80——红字把原始过账又做了一遍）", async () => {
    const caId = await runCount("90");
    expect(await balanceOf()).toBe("90.0000");

    // CA 行是带符号存的：−10
    const [caLine] = await db.select().from(stockDocLines).where(eq(stockDocLines.stockDocId, caId));
    expect(caLine.qty).toBe("-10.0000");

    await reverseAndApprove(caId);
    expect(await balanceOf(), "红字必须抵消盘亏，而不是再亏一次").toBe("100.0000");

    // 红字流水必须是原始流水的相反数（+10），不是同号的 −10
    const redLedger = await db.select().from(stockLedger)
      .where(eq(stockLedger.sourceDocType, "stock_doc"));
    expect(redLedger).toHaveLength(1);
    expect(redLedger[0].qtyDelta).toBe("10.0000");
    expect(redLedger[0].action).toBe(`reverse:count_adjust#${caId}`);
  });

  it("盘盈 100→130 冲销后余额同样回到 100（正负两个方向都要抵消）", async () => {
    const caId = await runCount("130");
    expect(await balanceOf()).toBe("130.0000");
    const [caLine] = await db.select().from(stockDocLines).where(eq(stockDocLines.stockDocId, caId));
    expect(caLine.qty).toBe("30.0000");

    await reverseAndApprove(caId);
    expect(await balanceOf()).toBe("100.0000");

    const redLedger = await db.select().from(stockLedger).where(eq(stockLedger.sourceDocType, "stock_doc"));
    expect(redLedger[0].qtyDelta).toBe("-30.0000");
  });

  it("红字单本身落 completed，且同一张 CA 不能被冲销第二次（防重放）", async () => {
    const caId = await runCount("90");
    await reverseAndApprove(caId);
    const [red] = await db.select().from(stockDocs).where(eq(stockDocs.reversalOfId, caId));
    expect(red.status).toBe("completed");
    await expect(reverseStockDoc(creator, caId, { reason: "再冲一次试试" }, db))
      .rejects.toMatchObject({ status: 409 });
    expect(await balanceOf()).toBe("100.0000");
  });
});
