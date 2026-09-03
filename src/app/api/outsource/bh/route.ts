import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createBh, listBhs } from "@/server/modules/outsource/bh";

export async function GET(req: NextRequest) {
  try {
    // D62：受限 ops 只见本人制单或本渠道制单人的单据（service 内按 user.channelScope 裁剪）
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await listBhs(q, { status: searchParams.get("status") ?? undefined, page, pageSize }, undefined, user),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 角色（ops）在 service 内校验
    return NextResponse.json(await createBh(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
