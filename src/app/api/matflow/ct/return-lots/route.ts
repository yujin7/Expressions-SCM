import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { parseSelectedValues } from "@/server/core/selected-options";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { listCtReturnLots } from "@/server/modules/matflow/return-lots";

const id = z.coerce.number().int().positive().max(2147483647);
const query = z.object({ poId: id, poLineId: id, warehouseId: id, q: z.string().max(100).default(""),
  page: id.default(1), pageSize: id.max(50).default(50), selectedValues: z.string().optional(),
}).strict();
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const sp = new URL(req.url).searchParams;
    if ([...sp.keys()].some(key => sp.getAll(key).length > 1)) throw new ApiError(400, "重复筛选参数");
    const input = query.parse(Object.fromEntries(sp));
    const selected = parseSelectedValues(sp);
    if (selected?.some(value => typeof value !== "number" && value !== "unbatched")) throw new ApiError(400, "批次选择值无效");
    return NextResponse.json(await listCtReturnLots(user, { ...input, ids: selected?.map(String) }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
