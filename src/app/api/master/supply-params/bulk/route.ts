import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { bulkFillSupplyParams } from "@/server/modules/master/sku-supply-params-bulk";

/**
 * 周期主数据批量补录（#1）：`dryRun` 出预演口径，去掉 `dryRun` 才写。
 *
 * 审计随写入落在同一事务内（sku-supply-params-bulk.ts 逐 SKU 一条），
 * 此处不补记——路由层补记走的是新连接且在服务提交之后，进程挂在中间就会「有数据无审计」。
 * 写守卫用 guardFreshWrite 回查 DB（角色可能刚被撤销）。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const input = await readJson(req) as Record<string, unknown> | null;
    if (input?.dryRun !== true && typeof input?.expectedPreview !== "string") throw new ApiError(400, "请先预演当前目标，再确认写入");
    return NextResponse.json(await bulkFillSupplyParams(user, input));
  } catch (e) {
    return errorResponse(e, { path: "/api/master/supply-params/bulk", method: "POST" });
  }
}
