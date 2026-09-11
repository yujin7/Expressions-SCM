import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { CHAIN_DOC_TYPES, getChain, type ChainDocType } from "@/server/modules/outsource/chain";

/** 链路视图：?docType=po&id=123 → 以 WO 为中心的委外全链节点 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const sp = new URL(req.url).searchParams;
    const docType = sp.get("docType") ?? "";
    if (!(CHAIN_DOC_TYPES as readonly string[]).includes(docType)) {
      throw new ApiError(400, `不支持的单据类型: ${docType || "(空)"}`);
    }
    const id = parseId(sp.get("id") ?? "");
    return NextResponse.json(await getChain({ docType: docType as ChainDocType, id }, undefined, user));
  } catch (e) {
    return errorResponse(e);
  }
}
