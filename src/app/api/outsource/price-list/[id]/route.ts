import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { deletePriceList, updatePriceList } from "@/server/modules/outsource/price-list";

/**
 * 采购价目表单行：改价（PATCH，只允许价格/币种——身份字段变了就是另一行）与删除（DELETE）。
 * 角色门与审计在服务层（`outsource/price-list.ts`）；已生效行只有 admin 能删。
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const body = await readJson(req);
    return NextResponse.json(await updatePriceList(user, parseId(id), body));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(await deletePriceList(user, parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}
