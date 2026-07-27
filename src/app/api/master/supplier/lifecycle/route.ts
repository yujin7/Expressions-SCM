import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, guardWrite, readJson } from "@/server/modules/master/common";
import {
  listSupplierLifecycleCases,
  openSupplierLifecycleCase,
} from "@/server/modules/master/supplier-lifecycle";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const params = req.nextUrl.searchParams;
    return NextResponse.json(
      await listSupplierLifecycleCases({
        q: params.get("q") ?? "",
        page: Number(params.get("page")) || 1,
        pageSize: Number(params.get("pageSize")) || 20,
        status: params.get("status") ?? "",
        kind: params.get("kind") ?? "",
        supplierId: Number(params.get("supplierId")) || undefined,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("supplier");
    return NextResponse.json(
      await openSupplierLifecycleCase(user, await readJson(req)),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
