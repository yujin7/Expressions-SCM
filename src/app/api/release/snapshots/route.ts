// 快照仓周期刷新（D20 运营环）：stock_opening_candidate → stock_snapshots（只吃快照仓）
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardRelease, releaseSnapshots } from "@/server/modules/release/engine";
import { releaseSnapshotsBody } from "@/server/modules/release/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await guardRelease();
    const body = releaseSnapshotsBody.parse(await readJson(req));
    return NextResponse.json(await releaseSnapshots(user, body));
  } catch (e) {
    return errorResponse(e);
  }
}
