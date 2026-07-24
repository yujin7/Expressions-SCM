import { NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getWorkbenchFocus } from "@/server/modules/workbench/focus";

/** 工作台聚焦数据：按当前用户角色返回真实计数区块（全部可点击跳转） */
export async function GET() {
  try {
    const user = await guardRead();
    const focus = await getWorkbenchFocus(user.roles);
    return NextResponse.json(focus);
  } catch (e) {
    return errorResponse(e);
  }
}
