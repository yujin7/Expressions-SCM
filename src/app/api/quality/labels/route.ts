import { NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  guardRead,
  parseId,
  readJson,
} from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  listElectronicLabels,
  publishElectronicLabel,
} from "@/server/modules/quality/service";

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const searchParams = new URL(req.url).searchParams;
    const skuId = searchParams.get("skuId");
    return NextResponse.json(await listElectronicLabels(user, {
      skuId: skuId ? parseId(skuId) : undefined,
      marketCode: searchParams.get("marketCode") ?? undefined,
    }));
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/labels", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const created = await publishElectronicLabel(user, await readJson(req));
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/labels", method: "POST" });
  }
}
