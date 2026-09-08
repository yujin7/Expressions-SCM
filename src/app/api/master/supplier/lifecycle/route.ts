import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, guardWrite, readJson } from "@/server/modules/master/common";
import {
  listSupplierLifecycleCases,
  openSupplierLifecycleCase,
} from "@/server/modules/master/supplier-lifecycle";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { optionalIntegerQuery } from "@/server/core/query-number";

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    requireAnyRole(user, "purchasing", "pmc", "finance");
    const params = req.nextUrl.searchParams;
    return NextResponse.json(
      await listSupplierLifecycleCases({
        q: params.get("q") ?? "",
        page: optionalIntegerQuery(params, "page", { label: "页码" }) ?? 1,
        pageSize: optionalIntegerQuery(params, "pageSize", { label: "每页条数", max: 200 }) ?? 20,
        status: params.get("status") ?? "",
        kind: params.get("kind") ?? "",
        supplierId: optionalIntegerQuery(params, "supplierId", { label: "供应商 ID" }),
        caseId: optionalIntegerQuery(params, "caseId", { label: "工作项 ID" }),
        ownerId: optionalIntegerQuery(params, "ownerId", { label: "责任人 ID" }),
        sort: params.get("sort") ?? "", order: params.get("order") ?? "",
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
