/**
 * 调拨建议 → DB 调拨单**草稿**的交接（TR-11），以及线路汇总 `lanes` 的可消费性。
 *
 * 两件此前断掉的事：
 * 1. 服务端算了 `lanes`（按 (调出仓, 调入仓) 分组的只读汇总），客户端接口里根本没这个字段 —— 白算；
 * 2. 页面说「采纳后请按 DB 调拨单正常流程开单」，但没有任何入口：
 *    用户得记下编码和数量，切到库存单据页从头手敲一遍。
 *
 * 纪律（本文件逐条钉住）：
 * - 装配是**纯函数**（`@/lib/transfer-draft`），报表层仍然不写库；
 * - 一张 DB 单只有一个 (源仓, 转入仓)，跨线路必须拆单——合并会把 to_warehouse_id 混装、把货发错仓；
 * - 只建**草稿**：不提交、不审批、**不过账**（stock_ledger / stock_balances 一行不动）；
 * - 审计走既有 create 路径（entity=stock_doc, action=create），与手工建单同一条。
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auditLogs, salesMonthly, channels, skus, spus, stockBalances, stockDocLines, stockDocs, stockLedger,
  users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";
import { getTransferSuggestions } from "@/server/modules/report/transfer-suggest";
import { createStockDoc } from "@/server/modules/inventory/stock-doc";
import { groupTransferDraftLanes, transferDraftPayload, type TransferDraftSourceRow } from "@/lib/transfer-draft";
import { todayShanghai } from "@/server/modules/master/common";

describe("lib/transfer-draft：线路装配（纯函数）", () => {
  const r = (p: Partial<TransferDraftSourceRow> & { skuId: number; code: string }): TransferDraftSourceRow => ({
    name: `品${p.code}`, baseUom: "支",
    fromWarehouseId: 1, fromWarehouse: "A仓", toWarehouseId: 2, toWarehouse: "B仓", qty: 10,
    ...p,
  });

  it("按 (调出仓, 调入仓) 分组：跨线路绝不合并成一张单", () => {
    const lanes = groupTransferDraftLanes([
      r({ skuId: 1, code: "S1", qty: 10 }),
      r({ skuId: 2, code: "S2", qty: 5 }),
      r({ skuId: 3, code: "S3", qty: 7, toWarehouseId: 3, toWarehouse: "C仓" }),
    ]);
    expect(lanes.map((l) => [l.key, l.lines.length, l.totalQty])).toEqual([
      ["1>2", 2, 15],
      ["1>3", 1, 7],
    ]);
    expect(lanes[0].lines.map((l) => [l.code, l.qty])).toEqual([["S1", "10.0000"], ["S2", "5.0000"]]);
  });

  it("qty ≤ 0 的建议不成单（服务端也会拒，但不该让用户点了才知道）", () => {
    expect(groupTransferDraftLanes([r({ skuId: 1, code: "S1", qty: 0 })])).toEqual([]);
  });

  it("载荷形状即 createStockDocSchema（transfer）；备注自带出处", () => {
    const [lane] = groupTransferDraftLanes([r({ skuId: 1, code: "S1", qty: 10 })]);
    const payload = transferDraftPayload(lane, { transferType: "inter_warehouse", reason: "借调", remark: "9 月大促备货" });
    expect(payload).toEqual({
      subtype: "transfer",
      warehouseId: 1,
      toWarehouseId: 2,
      transferType: "inter_warehouse",
      reason: "借调",
      remark: "来源：调拨建议页（先挪后买）1 条建议；9 月大促备货",
      lines: [{ skuId: 1, qty: "10.0000" }],
    });
    // 未填业务原因时不带 reason 键（R16：业务原因仅调拨单填写，空串不算填）
    expect(transferDraftPayload(lane, { transferType: "other" })).not.toHaveProperty("reason");
  });
});

describe("调拨建议 → DB 调拨单草稿（PGlite）", () => {
  let db: TestDb;
  let warehouseUser: SessionUser;
  let skuId = 0;
  const today = todayShanghai();

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "仓管", roles: ["warehouse"], isApprover: false }).returning();
    warehouseUser = { id: u.id, name: u.name, roles: ["warehouse"], isApprover: false };

    const [spu] = await db.insert(spus).values({ code: "P60001", nameCn: "调拨交接测试品" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "CP60001", name: "调拨交接成品", spuId: spu.id, skuType: "finished", baseUom: "支", active: true,
    }).returning();
    skuId = sku.id;

    const [whA] = await db.insert(warehouses).values({
      code: "TW-A", name: "积压仓A", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();
    const [whB] = await db.insert(warehouses).values({
      code: "TW-B", name: "断货仓B", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();

    await db.insert(stockBalances).values([
      { skuId, warehouseId: whA.id, batchId: null, qty: "1000.0000" },
    ]);
    const recent = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86_400_000);
    await db.insert(stockLedger).values([
      {
        skuId, warehouseId: whB.id, batchId: null, qtyDelta: "-900.0000",
        sourceDocType: "sales_out", sourceDocId: 1, action: "post", occurredAt: recent,
      },
    ]);
    const [ch] = await db.insert(channels).values({ code: "CH-TD", name: "渠道", kind: "platform" }).returning();
    await db.insert(salesMonthly).values([{ skuId, channelId: ch.id, yearMonth: "2026-08", qty: "900" }]);
  });

  it("服务端下发 lanes（未分页全量汇总），字段齐备可直接上屏", async () => {
    const res = await getTransferSuggestions({ pageSize: 50 }, db);
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.lanes.length).toBe(1);
    expect(res.lanes[0]).toMatchObject({
      fromWarehouse: "积压仓A",
      toWarehouse: "断货仓B",
      lineCount: res.summary.lineCount,
      skuCount: 1,
    });
    expect(res.lanes[0].totalQty).toBe(res.summary.totalQty);
  });

  it("从建议生成草稿：草稿态、明细与建议一致、不产生任何流水、审计走既有 create 路径", async () => {
    const res = await getTransferSuggestions({ pageSize: 50 }, db);
    const [lane] = groupTransferDraftLanes(res.rows);
    expect(lane).toBeDefined();

    const ledgerBefore = (await db.select().from(stockLedger)).length;
    const doc = await createStockDoc(
      warehouseUser,
      transferDraftPayload(lane, { transferType: "inter_warehouse" }),
      db,
    );

    expect(doc.subtype).toBe("transfer");
    expect(doc.status).toBe("draft"); // 只建草稿：不提交、不审批、不过账
    expect(doc.docNo.startsWith("DB")).toBe(true);
    expect(doc.remark).toContain("来源：调拨建议页");

    const lines = await db.select().from(stockDocLines).where(eq(stockDocLines.stockDocId, doc.id));
    expect(lines.map((l) => [l.skuId, l.qty])).toEqual([[skuId, `${res.rows[0].qty}.0000`]]);
    expect(lines[0].warehouseId).toBe(lane.fromWarehouseId);
    expect(lines[0].toWarehouseId).toBe(lane.toWarehouseId);

    // 过账绝不发生
    expect((await db.select().from(stockLedger)).length).toBe(ledgerBefore);
    const [bal] = await db.select().from(stockBalances).where(eq(stockBalances.skuId, skuId));
    expect(bal.qty).toBe("1000.0000");

    // 审计与手工建单同一条路径（同事务内写）
    const audits = await db.select().from(auditLogs)
      .where(and(eq(auditLogs.entity, "stock_doc"), eq(auditLogs.action, "create")));
    expect(audits.length).toBe(1);
    expect(audits[0].userId).toBe(warehouseUser.id);
    expect(audits[0].after).toMatchObject({ docNo: doc.docNo, subtype: "transfer", transferType: "inter_warehouse", lineCount: 1 });

    // 草稿确实进了库存单据列表（不是孤儿）
    const docs = await db.select().from(stockDocs).where(eq(stockDocs.subtype, "transfer"));
    expect(docs.map((d) => d.id)).toEqual([doc.id]);
  });
});
