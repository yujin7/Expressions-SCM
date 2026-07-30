import { NextRequest, NextResponse } from "next/server";
import {
  createSkuIdentifier,
  listSkuIdentifiers,
  setSkuIdentifierActive,
} from "@/server/modules/master/sku-identifier";
import {
  ApiError,
  errorResponse,
  guardRead,
  guardWrite,
  parseId,
  readJson,
} from "@/server/modules/master/common";

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Context) {
  try {
    await guardRead();
    return NextResponse.json(await listSkuIdentifiers(parseId((await ctx.params).id)));
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/[id]/identifiers", method: "GET" });
  }
}

export async function POST(req: NextRequest, ctx: Context) {
  try {
    const user = await guardWrite("sku");
    const skuId = parseId((await ctx.params).id);
    return NextResponse.json(
      await createSkuIdentifier(skuId, await readJson(req), user),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/[id]/identifiers", method: "POST" });
  }
}

export async function PATCH(req: NextRequest, ctx: Context) {
  try {
    const user = await guardWrite("sku");
    const skuId = parseId((await ctx.params).id);
    const body = await readJson<{ identifierId?: unknown; active?: unknown }>(req);
    if (!Number.isInteger(body.identifierId) || Number(body.identifierId) <= 0) {
      throw new ApiError(400, "identifierId 必须是正整数");
    }
    if (typeof body.active !== "boolean") throw new ApiError(400, "active 必须是布尔值");
    return NextResponse.json(
      await setSkuIdentifierActive(skuId, Number(body.identifierId), body.active, user),
    );
  } catch (error) {
    return errorResponse(error, { path: "/api/master/sku/[id]/identifiers", method: "PATCH" });
  }
}
