import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { generateConfirmToken } from "@/server/modules/outsource/po-confirm";

/** 买手生成供应商确认链接（purchasing/pmc/admin，新鲜会话回查） */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await params;
    return NextResponse.json(await generateConfirmToken(user, parseId(id)), { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
