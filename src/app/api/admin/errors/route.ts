import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { guardAdmin } from "@/server/modules/admin/users";
import { listErrorLogs } from "@/server/modules/admin/health";

export const dynamic = "force-dynamic";

/** 运行错误留档列表（仅 admin；?limit=50，上限 200） */
export async function GET(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    guardAdmin(user);
    const limit = Number(new URL(req.url).searchParams.get("limit")) || 50;
    return NextResponse.json({ rows: await listErrorLogs(limit) });
  } catch (e) {
    return errorResponse(e, { path: "/api/admin/errors", method: "GET" });
  }
}
