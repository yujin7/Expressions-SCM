import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createWo, listWos } from "@/server/modules/outsource/wo";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await listWos(q, { status: searchParams.get("status") ?? undefined, page, pageSize }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 角色（pmc）在 service 内校验
    return NextResponse.json(await createWo(user, await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
