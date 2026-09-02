import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { getPoByToken, submitPoConfirm } from "@/server/modules/outsource/po-confirm";

function protectTokenResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

/** #13 供应商确认门户（公开，token 门控——无会话守卫；仅读单据摘要/写确认交期） */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const response = NextResponse.json(await getPoByToken(token));
    // 与同目录 e-label 对齐：响应体含单号/供应商/物料/数量/交期，属带 token 的私有内容，
    // 绝不能被任何中间代理或 CDN 缓存。上公网（Cloudflare 隧道）后这条尤其要紧——
    // 2026-08-07 审计实测本端点当时完全没有 Cache-Control 响应头。
    return protectTokenResponse(response);
  } catch (e) {
    return protectTokenResponse(errorResponse(e));
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const body = (await readJson(req)) as {
      expectedDate: string;
      note?: string;
      lines?: Array<{ poLineId: number; expectedDate: string }>;
    };
    return protectTokenResponse(NextResponse.json(await submitPoConfirm(token, body), { status: 200 }));
  } catch (e) {
    return protectTokenResponse(errorResponse(e));
  }
}
