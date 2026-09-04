// 简版周期补录表放行（#2）：staging sku_leadtime_simple → sku_params；缺省只填空，overwrite 才覆盖
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRelease } from "@/server/modules/release/engine";
import { releaseSkuLeadtimeSimple } from "@/server/modules/release/engine/sku-leadtime-simple";
import { releasePlainBody } from "@/server/modules/release/schemas";

const body = releasePlainBody.extend({ overwrite: z.boolean().default(false) });

export async function POST(req: NextRequest) {
  try {
    const user = await guardRelease();
    const v = body.parse(await readJson(req));
    return NextResponse.json(await releaseSkuLeadtimeSimple(user, v));
  } catch (e) {
    return errorResponse(e);
  }
}
