import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { maskSensitive } from "@/server/core/dto";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { listPcs } from "@/server/modules/outsource/po";
import { createPcForJgFee } from "@/server/modules/outsource/jg";

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { page, pageSize, searchParams } = parseListQuery(req.url);
    // listPcs 内按 canSeePrices 剥 oldPrice/newPrice/deviationPct；再套 maskSensitive 兜底
    return NextResponse.json(
      maskSensitive(
        await listPcs(user.roles, {
          status: searchParams.get("status") ?? undefined,
          target: searchParams.get("target") ?? undefined,
          page,
          pageSize,
        }),
        user.roles,
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

/** 手工发起仅限 target=jg_fee（po_line PC 由 PO 提交 R1 自动生成） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 角色（purchasing）在 service 内校验
    return NextResponse.json(await createPcForJgFee(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
