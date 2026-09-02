import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getDashboard } from "@/server/modules/report/dashboard";

/** 经营驾驶舱聚合（只读；结算金额按【新鲜】角色裁剪——金额可见性不吃 8h JWT 缓存，RT4） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const fresh = await getFreshSessionUser(); // 角色被摘立即失去金额行
    // 跨维筛选只作用于销售类聚合；库存/临期/待审批等不跟随，
    // 返回体的 scope.notAppliedTo 会把这一点交代给界面（否则同页会自相矛盾）
    const sp = req.nextUrl.searchParams;
    const brand = sp.get("brand")?.trim() || undefined;
    const channel = sp.get("channel")?.trim() || undefined;
    const started = performance.now();
    const result = await getDashboard(fresh.roles, { brand, channel });
    const response = NextResponse.json(result);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Server-Timing", `dashboard;dur=${(performance.now() - started).toFixed(1)}`);
    return response;
  } catch (e) {
    return errorResponse(e);
  }
}
