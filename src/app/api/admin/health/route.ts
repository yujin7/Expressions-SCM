import { NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { guardAdmin } from "@/server/modules/admin/users";
import { getOpsHealth } from "@/server/modules/admin/health";

export const dynamic = "force-dynamic"; // 运维面板必须新鲜出数

/** 运维健康聚合（仅 admin） */
export async function GET() {
  try {
    const user = await getFreshSessionUser();
    guardAdmin(user);
    return NextResponse.json(await getOpsHealth());
  } catch (e) {
    return errorResponse(e, { path: "/api/admin/health", method: "GET" });
  }
}
