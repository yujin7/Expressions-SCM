import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { createBin, listBins } from "@/server/modules/master/bin";
import { ApiError, errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";

async function binWriter() {
  const user = await getFreshSessionUser();
  try {
    requireRole(user, "warehouse");
  } catch {
    throw new ApiError(403, "仅仓管或管理员可维护库位");
  }
  return user;
}

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const warehouseId = Number(searchParams.get("warehouseId"));
    const activeRaw = searchParams.get("active");
    return NextResponse.json(await listBins({
      q,
      page,
      pageSize,
      warehouseId: Number.isInteger(warehouseId) && warehouseId > 0 ? warehouseId : undefined,
      kind: searchParams.get("kind") || undefined,
      active: activeRaw === "true" ? true : activeRaw === "false" ? false : undefined,
    }));
  } catch (error) {
    return errorResponse(error, { path: "/api/master/bin", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await binWriter();
    return NextResponse.json(await createBin(await readJson(req), user), { status: 201 });
  } catch (error) {
    return errorResponse(error, { path: "/api/master/bin", method: "POST" });
  }
}
