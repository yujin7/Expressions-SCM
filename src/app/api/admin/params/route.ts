import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { requireRole } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { listParams, updateParam } from "@/server/modules/admin/params";

/** 运行参数：读=业务角色，写=admin（新鲜身份） */
export async function GET() {
  try {
    const user = await getFreshSessionUser();
    requireRole(user, "pmc", "purchasing", "finance");
    return NextResponse.json({ rows: await listParams() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    await updateParam(user, await req.json());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
