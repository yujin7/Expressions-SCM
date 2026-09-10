import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { createBin, listBins, BIN_SORT_KEYS } from "@/server/modules/master/bin";
import { ApiError, errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { parseMasterListQuery } from "@/server/modules/master/list-query";

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
    const { q, page, pageSize, searchParams, sort, order } = parseMasterListQuery(req.url, BIN_SORT_KEYS);
    for (const key of ["warehouseId", "kind", "active"]) if (searchParams.getAll(key).length > 1) throw new ApiError(400, `${key} 不能重复传入`);
    const warehouseId = Number(searchParams.get("warehouseId"));
    const activeRaw = searchParams.get("active");
    const kind = searchParams.get("kind") || undefined;
    if (searchParams.get("warehouseId") && (!Number.isSafeInteger(warehouseId) || warehouseId <= 0 || warehouseId > 2_147_483_647)) throw new ApiError(400, "仓库 ID 无效");
    if (activeRaw && activeRaw !== "true" && activeRaw !== "false") throw new ApiError(400, "启用状态必须是 true 或 false");
    if (kind && !["normal", "quarantine", "staging"].includes(kind)) throw new ApiError(400, "库位用途无效");
    return NextResponse.json(await listBins({
      q,
      page,
      pageSize,
      sort,
      order,
      warehouseId: Number.isInteger(warehouseId) && warehouseId > 0 ? warehouseId : undefined,
      kind,
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
