import { NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getDashboard } from "@/server/modules/report/dashboard";

/** 经营驾驶舱聚合（只读；结算金额已在聚合层按角色裁剪） */
export async function GET() {
  try {
    const user = await guardRead();
    return NextResponse.json(await getDashboard(user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
