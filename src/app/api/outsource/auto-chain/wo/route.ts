import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { generateWoFromBhLine } from "@/server/modules/outsource/auto-chain";

/** 按预演建议为 BH 行生成 WO 草稿（人工点按） */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    requireRole(user, "pmc");
    const v = z.object({ bhId: z.number().int().positive(), bhLineId: z.number().int().positive().optional(), skuId: z.number().int().positive() }).parse(await readJson(req));
    const result = await generateWoFromBhLine(user, v);
    return NextResponse.json(result, { status: result.idempotent ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
