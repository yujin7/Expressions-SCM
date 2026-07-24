import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { previewAutoChain } from "@/server/modules/outsource/auto-chain";
import { createWo } from "@/server/modules/outsource/wo";

/** 按预演建议为 BH 行生成 WO 草稿（人工点按） */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    requireRole(user, "pmc");
    const v = z.object({ bhId: z.number().int().positive(), skuId: z.number().int().positive() }).parse(await req.json());
    const { wos } = await previewAutoChain();
    const s = wos.find((w) => w.bhId === v.bhId && w.skuId === v.skuId);
    if (!s) return NextResponse.json({ error: "无此建议" }, { status: 404 });
    if (s.blockedReason) return NextResponse.json({ error: s.blockedReason }, { status: 409 });
    const wo = await createWo(user, {
      productSkuId: s.skuId,
      supplierId: s.supplierId!,
      qty: Number(s.qty),
      feeRatePlan: Number(s.feeRatePlan),
      bhId: s.bhId,
      remark: `预演生成（D33；来源 ${s.bhDocNo}）`,
    });
    return NextResponse.json({ id: wo.id, docNo: wo.docNo }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
