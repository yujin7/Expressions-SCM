import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { listBatchPlacements, quarantineOrReleaseBatch } from "@/server/modules/inventory/bin-operations";
import { ApiError, errorResponse, guardRead, readJson } from "@/server/modules/master/common";

/**
 * W2-6 批次隔离 / 放行。
 *
 * GET  ?skuId=&batchId=  → 该 (SKU, 批次) 当前的物理分布 + 各仓可选库位；
 * POST {intent:'quarantine'|'release', …} → 执行隔离/放行（写入与审计在 postBinMovement 内同事务）。
 *
 * 质量侧触发（不合格判定自动隔离）由质量域调用本能力，不在这里实现。
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const skuId = Number(sp.get("skuId"));
    if (!Number.isInteger(skuId) || skuId <= 0) throw new ApiError(400, "必须提供 skuId");
    const rawBatch = sp.get("batchId");
    const batchId = rawBatch == null || rawBatch === "" ? null : Number(rawBatch);
    if (batchId != null && (!Number.isInteger(batchId) || batchId <= 0)) {
      throw new ApiError(400, "batchId 非法");
    }
    return NextResponse.json(await listBatchPlacements({ skuId, batchId }));
  } catch (error) {
    return errorResponse(error, { path: "/api/inventory/quarantine", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    try {
      requireRole(user, "warehouse");
    } catch {
      throw new ApiError(403, "仅仓管或管理员可执行隔离/放行");
    }
    return NextResponse.json(await quarantineOrReleaseBatch(user, await readJson(req)), { status: 201 });
  } catch (error) {
    return errorResponse(error, { path: "/api/inventory/quarantine", method: "POST" });
  }
}
