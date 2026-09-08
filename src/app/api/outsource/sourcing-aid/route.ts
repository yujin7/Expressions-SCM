import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getSourcingAid } from "@/server/modules/outsource/sourcing-aid";
import { getCapacityCheck } from "@/server/modules/outsource/capacity-check";

/**
 * 选源决策辅助（W2 审计 6）：`/outsource/wo`「生成单据」旁的只读事实面板。
 * 含供应商基准价（R9 敏感金额）：走新鲜身份回查，金额由服务层按 canSeePrices 剥离，
 * 出口再过 maskSensitive 收口。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const url = new URL(req.url);
    if (url.searchParams.getAll("mode").length > 1) throw new ApiError(400, "选源参考模式不能重复");
    const mode = url.searchParams.get("mode");
    if (mode === "capacity") {
      for (const key of url.searchParams.keys()) {
        if (!["mode", "skuId", "supplierId", "dueDate", "candidateQty"].includes(key) || url.searchParams.getAll(key).length !== 1) {
          throw new ApiError(400, "产能核对参数未知或重复，请重新核对");
        }
      }
      const data = await getCapacityCheck(user, {
        skuId: url.searchParams.get("skuId"),
        supplierId: url.searchParams.get("supplierId") ?? undefined,
        dueDate: url.searchParams.get("dueDate") ?? undefined,
        candidateQty: url.searchParams.get("candidateQty") ?? undefined,
      });
      return NextResponse.json(maskSensitive(data, user.roles), { headers: { "Cache-Control": "private, no-store" } });
    }
    if (mode !== null) throw new ApiError(400, "未知选源参考模式");
    const skuId = Number(url.searchParams.get("skuId"));
    const supplierIds = (url.searchParams.get("supplierIds") ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    const data = await getSourcingAid(user, { skuId, supplierIds: supplierIds.length ? supplierIds : undefined });
    return NextResponse.json(maskSensitive(data, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
