import { NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getDashboard } from "@/server/modules/report/dashboard";

/** 经营驾驶舱聚合（只读；结算金额按【新鲜】角色裁剪——金额可见性不吃 8h JWT 缓存，RT4） */
export async function GET() {
  try {
    await guardRead();
    const fresh = await getFreshSessionUser(); // 角色被摘立即失去金额行
    return NextResponse.json(await getDashboard(fresh.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
