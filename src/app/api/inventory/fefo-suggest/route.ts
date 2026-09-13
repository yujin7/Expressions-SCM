import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { batches, skus } from "@/db/schema";
import { ApiError, errorResponse, guardRead } from "@/server/modules/master/common";
import { dAdd, dCmp } from "@/server/core/decimal";
import { suggestFefoAllocation } from "@/server/modules/inventory/fefo";
import { expandOutboundLinesForBatchPosting, isBatchPostingEnabled } from "@/server/modules/inventory/batch-allocation";
import { assertReviewedScrapSource } from "@/server/modules/inventory/reviewed-scrap";

/**
 * E2-12 FEFO 出库批次建议：GET ?skuId=&warehouseId=&qty=[&today=]
 * **只读**——给建议/核对原指定批次，不预留、不过账；保存仍重新校验。
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const skuId = Number(sp.get("skuId"));
    const warehouseId = Number(sp.get("warehouseId"));
    const sourceQuantities = sp.getAll("qty").map(value => value.trim());
    if (!Number.isInteger(skuId) || skuId <= 0 || skuId > 2147483647) {
      return NextResponse.json({ error: "缺少或非法的 skuId" }, { status: 400 });
    }
    if (!Number.isInteger(warehouseId) || warehouseId <= 0 || warehouseId > 2147483647) {
      return NextResponse.json({ error: "缺少或非法的 warehouseId" }, { status: 400 });
    }
    if (sourceQuantities.length < 1 || sourceQuantities.length > 1000
      || sourceQuantities.some(value => !/^\d{1,10}(\.\d{1,4})?$/.test(value))) throw new ApiError(400, "数量须为最多4位小数的正数，每次最多1000行");
    if (sourceQuantities.some(value => dCmp(value, "0") <= 0)) throw new ApiError(400, "数量必须大于0");
    // Repeated qty parameters represent independent lines of this SKU, not floating-point totals.
    const qty = sourceQuantities.reduce((total, value) => dAdd(total, value), "0.0000");
    const rawBatches = sp.getAll("batchId");
    if (rawBatches.length && rawBatches.length !== sourceQuantities.length) throw new ApiError(400, "批次与数量行不匹配");
    const sourceBatchIds = sourceQuantities.map((_, i) => {
      const value = rawBatches[i];
      if (value == null || value === "auto") return null;
      const batchId = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(batchId) || batchId <= 0 || batchId > 2147483647) throw new ApiError(400, "批次编号无效");
      return batchId;
    });
    if (sourceBatchIds.some(v => v != null) && sourceBatchIds.some(v => v == null)) throw new ApiError(400, "同一SKU不可混用指定批次与自动FEFO");
    const today = sp.get("today")?.trim() || undefined;
    const disposal = sp.get("riskDisposalId");
    const riskDisposalId = disposal == null ? null : Number(disposal);
    if (disposal != null && (!/^\d+$/.test(disposal) || !Number.isInteger(riskDisposalId) || riskDisposalId! <= 0 || riskDisposalId! > 2147483647)) throw new ApiError(400, "报废评审编号无效");
    const db = await getDbAsync();
    const [sku] = await db
      .select({ code: skus.code, name: skus.name, baseUom: skus.baseUom })
      .from(skus)
      .where(eq(skus.id, skuId));
    if (!sku) {
      return NextResponse.json({ error: "SKU 不存在" }, { status: 404 });
    }
    if (riskDisposalId) await assertReviewedScrapSource(db, riskDisposalId, [sku.code]);
    const mode = sourceBatchIds[0] == null ? "automatic" : "explicit";
    let suggestion;
    if (mode === "explicit") {
      if (today) throw new ApiError(400, "指定批次核对仅支持当前业务日");
      if (!(await isBatchPostingEnabled(db))) throw new ApiError(409, "批次规则已关闭，请返回后重新读取规则");
      const expanded = await expandOutboundLinesForBatchPosting(db, warehouseId,
        sourceQuantities.map((value, i) => ({ skuId, qty: value, batchId: sourceBatchIds[i] })), riskDisposalId ? "reviewed_scrap" : "use");
      const ids = [...new Set(sourceBatchIds)] as number[];
      const lots = await db.select({ id: batches.id, batchNo: batches.batchNo, expiryDate: batches.expiryDate }).from(batches).where(inArray(batches.id, ids));
      const allocations = lots.map(lot => ({ batchId: lot.id, batchNo: lot.batchNo, expiryDate: lot.expiryDate,
        qty: expanded.filter(line => line.batchId === lot.id).reduce((total, line) => dAdd(total, line.qty), "0.0000") }));
      if (lots.length !== ids.length || dCmp(allocations.reduce((total, line) => dAdd(total, line.qty), "0.0000"), qty) !== 0) {
        throw new ApiError(409, "指定批次依据已变化，请重新读取");
      }
      suggestion = { allocations, fallbackQty: "0.0000", shortBy: "0.0000", expiredLots: 0, batchCoverage: true,
        note: riskDisposalId ? "原指定批次；报废评审来源已核对，允许过期批次报废，不可转作普通使用；未预留库存。" : "保留原请求指定批次，已按当前归属、效期及未定位可发量核对；不是自动FEFO，未预留库存。" };
    } else suggestion = await suggestFefoAllocation(db, { skuId, warehouseId, qty, today });
    return NextResponse.json({
      skuId,
      warehouseId,
      sourceQuantities,
      sourceBatchIds,
      riskDisposalId,
      mode,
      skuCode: sku.code,
      skuName: sku.name,
      baseUom: sku.baseUom,
      requestedQty: qty,
      ...suggestion,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e, { path: "/api/inventory/fefo-suggest", method: "GET" });
  }
}
