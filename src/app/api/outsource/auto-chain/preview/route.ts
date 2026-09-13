import { NextResponse } from "next/server";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { previewAutoChain } from "@/server/modules/outsource/auto-chain";
import { getNumParam } from "@/server/core/params";

/** D33 预演（spec/11 上线闸）：只读展示将生成什么，不写库 */
export async function GET() {
  try {
    const user = await getFreshSessionUser();
    requireRole(user, "pmc");
    const data = await previewAutoChain(undefined, user);
    const flags = {
      autoWoOnBh: (await getNumParam("auto_wo_on_bh", 0)) === 1,
      autoJgOnReady: (await getNumParam("auto_jg_on_ready", 0)) === 1,
    };
    return NextResponse.json({ ...data, flags }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
