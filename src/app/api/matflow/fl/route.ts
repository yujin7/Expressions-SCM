import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, parseListQuery, readJson } from "@/server/modules/master/common";
import { canCreateMaterialDoc } from "@/server/modules/matflow/task-actions";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createFl, listFls } from "@/server/modules/matflow/fl";

export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const jgId = searchParams.has("jgId") ? parseId(searchParams.get("jgId") ?? "") : undefined;
    return NextResponse.json(
      { ...await listFls(q, { status: searchParams.get("status") ?? undefined, jgId, page, pageSize }),
        actions: { create: canCreateMaterialDoc(user) } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 仓管角色校验在 service 内（requireAnyRole warehouse）
    return NextResponse.json(await createFl(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
