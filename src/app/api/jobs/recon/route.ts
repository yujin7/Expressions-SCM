import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { ApiError, errorResponse, guardRead } from "@/server/modules/master/common";
import { getDbAsync } from "@/db";
import { reconDiffs, skus } from "@/db/schema";
import { summarizeDiffs } from "@/jobs/reconcile-jst";

/** GET /api/jobs/recon?bizDate=YYYY-MM-DD → 差异行（含 SKU 编码/名称）+ summary（重算，不触发重跑） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const bizDate = new URL(req.url).searchParams.get("bizDate") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bizDate)) throw new ApiError(400, "bizDate 须为 YYYY-MM-DD");
    const db = await getDbAsync();
    const rows = await db
      .select({
        id: reconDiffs.id,
        bizDate: reconDiffs.bizDate,
        skuId: reconDiffs.skuId,
        skuCode: skus.code,
        skuName: skus.name,
        sysQty: reconDiffs.sysQty,
        jstQty: reconDiffs.jstQty,
        diffQty: reconDiffs.diffQty,
        status: reconDiffs.status,
        note: reconDiffs.note,
      })
      .from(reconDiffs)
      .innerJoin(skus, eq(reconDiffs.skuId, skus.id))
      .where(eq(reconDiffs.bizDate, bizDate))
      .orderBy(asc(skus.code));
    const summary = summarizeDiffs(
      bizDate,
      rows.map((r) => ({ sysQty: Number(r.sysQty), jstQty: Number(r.jstQty), diffQty: Number(r.diffQty) })),
      0, // 落库行无 unresolved 概念；实时值见 POST /run 返回
    );
    return NextResponse.json({ rows, summary });
  } catch (e) {
    return errorResponse(e);
  }
}
