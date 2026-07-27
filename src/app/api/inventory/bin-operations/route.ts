import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import {
  listBinInventory,
  listBinMovements,
  postBinMovement,
} from "@/server/modules/inventory/bin-operations";
import { ApiError, errorResponse, guardRead, readJson } from "@/server/modules/master/common";

function warehouseIdFrom(req: NextRequest): number {
  const warehouseId = Number(new URL(req.url).searchParams.get("warehouseId"));
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
    throw new ApiError(400, "必须选择实时仓库");
  }
  return warehouseId;
}

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const url = new URL(req.url);
    const warehouseId = warehouseIdFrom(req);
    const [inventory, movements] = await Promise.all([
      listBinInventory({ warehouseId, q: url.searchParams.get("q") ?? "" }),
      listBinMovements(warehouseId),
    ]);
    return NextResponse.json({ inventory, movements });
  } catch (error) {
    return errorResponse(error, { path: "/api/inventory/bin-operations", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    try {
      requireRole(user, "warehouse");
    } catch {
      throw new ApiError(403, "仅仓管或管理员可执行库位作业");
    }
    return NextResponse.json(await postBinMovement(user, await readJson(req)), { status: 201 });
  } catch (error) {
    return errorResponse(error, { path: "/api/inventory/bin-operations", method: "POST" });
  }
}
