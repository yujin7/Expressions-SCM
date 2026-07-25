import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardWarehouseWrite } from "@/server/modules/inventory/stock-doc";
import { submitCountTask } from "@/server/modules/inventory/count";

const bodySchema = z.object({ version: z.number().int().positive() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWarehouseWrite();
    const { id } = await ctx.params;
    const { version } = bodySchema.parse(await readJson(req));
    return NextResponse.json(await submitCountTask(user, parseId(id), version));
  } catch (e) {
    return errorResponse(e);
  }
}
