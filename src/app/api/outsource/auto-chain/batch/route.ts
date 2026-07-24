import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { createBatchJg } from "@/server/modules/outsource/auto-chain";

/** 按预演建议生成一个 JG 批次草稿（人工点按=人工闸） */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const { woId } = z.object({ woId: z.number().int().positive() }).parse(await req.json());
    const jg = await createBatchJg(user, woId);
    return NextResponse.json({ id: jg.id, docNo: jg.docNo, batchSeq: jg.batchSeq, qty: jg.qty }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
