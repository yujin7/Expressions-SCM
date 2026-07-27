import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { getBin, updateBin } from "@/server/modules/master/bin";
import { ApiError, errorResponse, guardRead, parseId, readJson } from "@/server/modules/master/common";

async function binWriter() {
  const user = await getFreshSessionUser();
  try {
    requireRole(user, "warehouse");
  } catch {
    throw new ApiError(403, "仅仓管或管理员可维护库位");
  }
  return user;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    return NextResponse.json(await getBin(parseId((await ctx.params).id)));
  } catch (error) {
    return errorResponse(error, { path: "/api/master/bin/[id]", method: "GET" });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await binWriter();
    return NextResponse.json(await updateBin(parseId((await ctx.params).id), await readJson(req), user));
  } catch (error) {
    return errorResponse(error, { path: "/api/master/bin/[id]", method: "PUT" });
  }
}
