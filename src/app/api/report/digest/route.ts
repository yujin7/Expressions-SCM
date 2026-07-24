import { NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getDailyDigest } from "@/server/modules/report/digest";

/** 每日经营摘要：按当前用户角色装配 in-app 晨间简报（只读） */
export async function GET() {
  try {
    const user = await guardRead();
    const digest = await getDailyDigest(user.roles);
    return NextResponse.json(digest);
  } catch (e) {
    return errorResponse(e);
  }
}
