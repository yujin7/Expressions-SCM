import { NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getCockpit } from "@/server/modules/report/cockpit";

/**
 * 驾驶舱四屏装配（D50）。只读；金额块按角色在服务层给 no_access 空态，剩余金额键再经 maskSensitive 剥离。
 */
export async function GET() {
  try {
    const user = await guardRead();
    const db = await getDbAsync();
    const data = await getCockpit(user, db);
    const res = NextResponse.json(maskSensitive(data, user.roles));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    return errorResponse(e, { path: "/api/report/cockpit", method: "GET" });
  }
}
