/**
 * 供应商回的交期，内部必须看得见。
 *
 * 事故背景（2026-09-04 审计）：
 * 1) 供应商门户 `po-confirm.ts` 逐行回填 `po_lines.expected_date`，可 `getPo` 的 select
 *    里**根本没有这一列**——买手打开 PO 详情，行上一个字都没有，只剩表头一个日期；
 * 2) `po_promise_revisions` 是仅追加事实表，写了三年只被写不被读：供应商连续改期三次，
 *    内部页面看不到任何痕迹；
 * 3) 列表接口一直返回 `expectedDate` / `confirmedAt`，前端整列丢掉，还得一张张点开看谁逾期。
 *
 * 本测试钉住服务层契约（行交期、承诺时间线、列表派生字段），前端契约由
 * tests/components/po-promise-ui.test.ts 钉住。
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { poDocs, poLines, skus, spus, suppliers, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { generateConfirmToken, submitPoConfirm } from "@/server/modules/outsource/po-confirm";
import { getPo, listPos, poListProgress } from "@/server/modules/outsource/po";
import { createTestDb, type TestDb } from "../helpers/db";

describe("PO 交期承诺的内部可见性", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let poId = 0;
  let lineId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({
      username: "po-promise-buyer", name: "采购", roles: ["purchasing"], isApprover: true,
    }).returning();
    buyer = { id: user.id, name: user.name, roles: ["purchasing"], isApprover: true };
    const [supplier] = await db.insert(suppliers).values({
      code: "PP-SUP", name: "承诺供应商", kinds: ["material"], status: "qualified",
    }).returning();
    const [spu] = await db.insert(spus).values({ code: "PP-SPU", nameCn: "承诺产品" }).returning();
    const [sku] = await db.insert(skus).values({
      spuId: spu.id, code: "PP-SKU", name: "承诺物料", skuType: "raw", baseUom: "kg",
    }).returning();
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-PROMISE-1", status: "approved", supplierId: supplier.id, createdBy: user.id,
    }).returning();
    poId = po.id;
    const [line] = await db.insert(poLines).values({
      poId, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty: "10", price: "2",
    }).returning();
    lineId = line.id;
  });

  it("getPo 带出行级承诺交期与承诺变更时间线（门户改期两次 → 两条事实）", async () => {
    const before = await getPo(poId, db);
    expect(before.lines[0]).toHaveProperty("expectedDate", null);
    expect(before.promiseRevisions).toEqual([]);

    const first = await generateConfirmToken(buyer, poId, db);
    await submitPoConfirm(first.token, {
      expectedDate: "2026-08-10",
      lines: [{ poLineId: lineId, expectedDate: "2026-08-10" }],
    }, db);
    const second = await generateConfirmToken(buyer, poId, db);
    await submitPoConfirm(second.token, {
      expectedDate: "2026-08-20",
      lines: [{ poLineId: lineId, expectedDate: "2026-08-20" }],
      note: "原料延迟",
    }, db);

    const after = await getPo(poId, db);
    // 1) 行级交期不再隐身
    expect(after.lines[0]).toMatchObject({ id: lineId, expectedDate: "2026-08-20" });
    // 2) 承诺时间线可读，且是「新→旧」的仅追加事实（含物料与操作方）
    expect(after.promiseRevisions).toHaveLength(2);
    expect(after.promiseRevisions.map((r) => ({
      sequence: r.sequence, previousDate: r.previousDate, promisedDate: r.promisedDate,
      source: r.source, actorType: r.actorType, skuCode: r.skuCode, reason: r.reason,
    }))).toEqual([
      { sequence: 2, previousDate: "2026-08-10", promisedDate: "2026-08-20", source: "supplier_confirm", actorType: "supplier_token", skuCode: "PP-SKU", reason: "原料延迟" },
      { sequence: 1, previousDate: null, promisedDate: "2026-08-10", source: "supplier_confirm", actorType: "supplier_token", skuCode: "PP-SKU", reason: "供应商确认交期" },
    ]);
  });

  it("listPos 返回预计到货 / 已确认 / 已收% / 逾期天数（列表不再只有单号和行数）", async () => {
    const { token } = await generateConfirmToken(buyer, poId, db);
    await submitPoConfirm(token, { expectedDate: "2026-08-10" }, db);
    await db.update(poLines).set({ receivedQty: "4" }).where(eq(poLines.id, lineId));

    const { rows } = await listPos("", { page: 1, pageSize: 20 }, db) as {
      rows: { expectedDate: string | null; confirmedAt: Date | null; receivedPct: number | null; overdueDays: number | null }[];
    };
    expect(rows).toHaveLength(1);
    expect(rows[0].expectedDate).toBe("2026-08-10");
    expect(rows[0].confirmedAt).not.toBeNull();
    expect(rows[0].receivedPct).toBe(40);
  });

  it("列表派生规则：已收% 与逾期天数（无数量/未开单不猜）", () => {
    // 未到承诺日 → 不逾期；已过 → 逾期天数为正
    expect(poListProgress({ status: "in_progress", expectedDate: "2026-09-10", qtySum: "10", receivedSum: "2.5" }, "2026-09-04"))
      .toEqual({ receivedPct: 25, overdueDays: null });
    expect(poListProgress({ status: "in_progress", expectedDate: "2026-08-30", qtySum: "10", receivedSum: "10" }, "2026-09-04"))
      .toEqual({ receivedPct: 100, overdueDays: 5 });
    // 已关闭/已完成的单不再算逾期（短关就是为了把它移出待收桶）
    expect(poListProgress({ status: "closed", expectedDate: "2026-08-30", qtySum: "10", receivedSum: "3" }, "2026-09-04"))
      .toEqual({ receivedPct: 30, overdueDays: null });
    // 无数量 → null，不是 0%
    expect(poListProgress({ status: "approved", expectedDate: null, qtySum: null, receivedSum: null }, "2026-09-04"))
      .toEqual({ receivedPct: null, overdueDays: null });
  });
});
