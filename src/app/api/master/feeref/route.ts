import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { createFeeRef, guardFeeRefWrite, listFeeRefs } from "@/server/modules/master/feeref";

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const supplierRaw = searchParams.get("supplierId");
    const supplierId = supplierRaw ? Number(supplierRaw) : undefined;
    const result = await listFeeRefs({
      q,
      page,
      pageSize,
      supplierId: Number.isInteger(supplierId) && supplierId! > 0 ? supplierId : undefined,
    });
    // feeRate 敏感（R9）——序列化边界按角色剥离
    return NextResponse.json(maskSensitive(result, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFeeRefWrite();
    const result = await createFeeRef(user, await readJson(req));
    return NextResponse.json(maskSensitive(result, user.roles), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
