import { NextRequest, NextResponse } from "next/server";

import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, readJson } from "@/server/modules/master/common";
import {
  decideDataProductRelease,
  requestDataProductRelease,
} from "@/server/modules/report/data-product-release";

export async function POST(request: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(await requestDataProductRelease(user, await readJson(request)), { status: 201 });
  } catch (error) {
    return errorResponse(error, { path: "/api/report/data-product-releases", method: "POST" });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(await decideDataProductRelease(user, await readJson(request)));
  } catch (error) {
    return errorResponse(error, { path: "/api/report/data-product-releases", method: "PUT" });
  }
}
