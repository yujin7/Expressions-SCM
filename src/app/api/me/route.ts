import { NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";

/** 当前用户（角色感知 UI 的数据源——UX 走查 Top-4） */
export async function GET() {
  try {
    const user = await guardRead();
    return NextResponse.json({ id: user.id, name: user.name, roles: user.roles, isApprover: user.isApprover });
  } catch (e) {
    return errorResponse(e);
  }
}
