import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { maskSensitive } from "@/server/core/dto";
import { getJg } from "@/server/modules/outsource/jg";
import { getJgMaterialBasis } from "@/server/modules/matflow/material-basis";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // Read-only action hints and masking need current identity.
    const { id } = await ctx.params;
    const basis = _req.nextUrl.searchParams.getAll("materialBasis");
    if (basis.length && (basis.length !== 1 || basis[0] !== "1")) throw new ApiError(400, "物料依据参数无效");
    if (basis.length) return NextResponse.json(await getJgMaterialBasis(user, parseId(id)), {
      headers: { "Cache-Control": "private, no-store" },
    });
    // feeRateCurrent / 分段 feeRate 敏感（R9）——在此序列化边界按角色剥离
    return NextResponse.json(maskSensitive(await getJg(parseId(id), undefined, user), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
