import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { searchAll } from "@/server/modules/inbox/search";

/** 全局搜索：?q= → {groups:[{title, items:[{label, href, tag}]}]}（q<2 字符返回空组） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    return NextResponse.json(await searchAll(q));
  } catch (e) {
    return errorResponse(e);
  }
}
