import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { releaseSkuCosts } from "@/server/modules/release/engine";
import { releasePlainBody } from "@/server/modules/release/schemas";

/** 财务成本放行：服务层再次校验 finance/admin，路由只负责新鲜身份与结构校验。 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = releasePlainBody.parse(await readJson(req));
    return NextResponse.json(await releaseSkuCosts(user, body));
  } catch (error) {
    return errorResponse(error);
  }
}
