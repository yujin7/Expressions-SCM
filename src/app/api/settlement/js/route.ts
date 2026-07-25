import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createJs, listJss } from "@/server/modules/settlement/js";

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const jgId = Number(searchParams.get("jgId")) || undefined;
    const data = await listJss(q, {
      status: searchParams.get("status") ?? undefined,
      jgId,
      page,
      pageSize,
    });
    // feePayable/deductionTotal/settleAmount 敏感（R9）——序列化边界按角色剥离
    return NextResponse.json(maskSensitive(data, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 制单角色（pmc）由 service 校验
    const data = await createJs(user, await readJson(req));
    return NextResponse.json(maskSensitive(data, user.roles), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
