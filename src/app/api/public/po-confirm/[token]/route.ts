import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { getPoByToken, submitPoConfirm } from "@/server/modules/outsource/po-confirm";

/** #13 供应商确认门户（公开，token 门控——无会话守卫；仅读单据摘要/写确认交期） */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    return NextResponse.json(await getPoByToken(token));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const body = (await readJson(req)) as { expectedDate: string; note?: string };
    return NextResponse.json(await submitPoConfirm(token, body), { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
